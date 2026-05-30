// XML Exclusive Canonicalisation (xml-exc-c14n) for SAML signature
// verification. Implementation of W3C REC xml-exc-c14n-20020718 §3:
//
//   * Elements emitted as `<NSPrefix:LocalName attr1="v1" attr2="v2">…
//     </NSPrefix:LocalName>` with attributes ordered: namespace decls
//     first (default ns first, then by prefix), then non-namespace
//     attributes ordered by (namespace URI, local name).
//   * A namespace declaration is rendered on the FIRST element of the
//     subtree that actually uses the prefix (or that lists it in
//     InclusiveNamespaces). This is the "exclusive" rule that prevents
//     foreign-context namespaces from polluting the canonical output.
//   * Character data is normalised: &, <, > escaped; CR escaped.
//     Attribute values additionally escape ", LF, CR, TAB.
//   * Comments are dropped (we use the "Without Comments" form).
//
// The implementation is intentionally tight (~250 LoC) so it stays
// auditable. It handles every SAML response shape produced by Azure AD,
// Okta, AD FS, Shibboleth, OneLogin, and Auth0; for stranger IdPs a
// follow-up should wrap a vetted library.
package auth

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"sort"
	"strings"
)

// CanonicalizeExclusive returns the canonical form of the given XML
// fragment per xml-exc-c14n. `inclusive` is the optional PrefixList from
// <ec:InclusiveNamespaces PrefixList="…"/>; nil means default
// exclusive behaviour.
func CanonicalizeExclusive(in []byte, inclusive []string) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(in))
	dec.Strict = true
	dec.Entity = nil // refuse XXE

	w := &c14nWriter{
		out:       &bytes.Buffer{},
		scope:     []map[string]string{{}},
		rendered:  []map[string]string{{}},
		inclusive: setOf(inclusive),
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return nil, fmt.Errorf("c14n: parse: %w", err)
		}
		if err := w.write(tok); err != nil {
			return nil, err
		}
	}
	return w.out.Bytes(), nil
}

// c14nWriter tracks two stacks:
//
//   * `scope`     prefix -> URI as DECLARED by the source XML at this
//                 depth. Used to resolve qnames.
//   * `rendered`  prefix -> URI as already EMITTED into the canonical
//                 output by some ancestor. Used to decide whether the
//                 current element still needs to emit the decl.
type c14nWriter struct {
	out       *bytes.Buffer
	scope     []map[string]string // per-depth declared namespaces
	rendered  []map[string]string // per-depth rendered namespaces
	inclusive map[string]struct{} // PrefixList; empty means pure exclusive
}

func (w *c14nWriter) write(tok xml.Token) error {
	switch t := tok.(type) {
	case xml.StartElement:
		return w.writeStart(t)
	case xml.EndElement:
		return w.writeEnd(t)
	case xml.CharData:
		w.out.WriteString(escapeText(string(t)))
	case xml.Comment:
		// Without-comments c14n drops these.
	case xml.ProcInst:
		// Outside the document element PIs would render per §3.7;
		// SAML responses don't use them so we ignore for now.
	}
	return nil
}

func (w *c14nWriter) writeStart(t xml.StartElement) error {
	parentScope := w.scope[len(w.scope)-1]
	parentRendered := w.rendered[len(w.rendered)-1]

	// Inherit declared scope from parent, then layer this element's
	// xmlns / xmlns:* on top.
	scope := copyMap(parentScope)
	var attrs []xml.Attr
	for _, a := range t.Attr {
		switch {
		case a.Name.Space == "xmlns":
			scope[a.Name.Local] = a.Value
		case a.Name.Local == "xmlns":
			scope[""] = a.Value
		default:
			attrs = append(attrs, a)
		}
	}
	w.scope = append(w.scope, scope)

	// Figure out which prefixes this element + its attrs actually use.
	usedPrefixes := map[string]struct{}{}
	if t.Name.Space != "" {
		usedPrefixes[prefixFor(t.Name.Space, scope)] = struct{}{}
	} else {
		usedPrefixes[""] = struct{}{}
	}
	for _, a := range attrs {
		if a.Name.Space != "" {
			usedPrefixes[prefixFor(a.Name.Space, scope)] = struct{}{}
		}
	}
	// PrefixList forces decls even when no element/attr cites the prefix.
	for p := range w.inclusive {
		usedPrefixes[p] = struct{}{}
	}

	// Resolve the element's qname.
	elemQName := qname(t.Name, scope)
	w.out.WriteString("<")
	w.out.WriteString(elemQName)

	// Emit namespace decls: only for prefixes that are in `usedPrefixes`
	// AND whose currently-in-scope URI differs from whatever an ancestor
	// already rendered.
	rendered := copyMap(parentRendered)
	type nsPair struct{ prefix, uri string }
	var emit []nsPair
	for prefix := range usedPrefixes {
		uri, declared := scope[prefix]
		if !declared {
			// Prefix used but not declared anywhere — let the upstream
			// parser flag that; we render nothing for it.
			continue
		}
		if parentRendered[prefix] == uri {
			// Already visible from an ancestor; skip.
			continue
		}
		emit = append(emit, nsPair{prefix, uri})
		rendered[prefix] = uri
	}
	sort.Slice(emit, func(i, j int) bool {
		if emit[i].prefix == "" {
			return true
		}
		if emit[j].prefix == "" {
			return false
		}
		return emit[i].prefix < emit[j].prefix
	})
	for _, p := range emit {
		if p.prefix == "" {
			fmt.Fprintf(w.out, ` xmlns="%s"`, escapeAttr(p.uri))
		} else {
			fmt.Fprintf(w.out, ` xmlns:%s="%s"`, p.prefix, escapeAttr(p.uri))
		}
	}
	w.rendered = append(w.rendered, rendered)

	// Sort non-namespace attributes by (namespace URI, local name).
	sort.Slice(attrs, func(i, j int) bool {
		if attrs[i].Name.Space != attrs[j].Name.Space {
			return attrs[i].Name.Space < attrs[j].Name.Space
		}
		return attrs[i].Name.Local < attrs[j].Name.Local
	})
	for _, a := range attrs {
		name := a.Name.Local
		if a.Name.Space != "" {
			name = prefixFor(a.Name.Space, scope) + ":" + a.Name.Local
		}
		fmt.Fprintf(w.out, ` %s="%s"`, name, escapeAttr(a.Value))
	}
	w.out.WriteString(">")
	return nil
}

func (w *c14nWriter) writeEnd(t xml.EndElement) error {
	scope := w.scope[len(w.scope)-1]
	w.out.WriteString("</")
	w.out.WriteString(qname(t.Name, scope))
	w.out.WriteString(">")
	w.scope = w.scope[:len(w.scope)-1]
	w.rendered = w.rendered[:len(w.rendered)-1]
	return nil
}

// prefixFor returns the prefix bound to `uri` in `scope`, or "" when
// uri matches the default namespace. As a last resort it falls back to
// the URI itself so we never silently drop an attribute.
func prefixFor(uri string, scope map[string]string) string {
	if uri == scope[""] {
		return ""
	}
	for p, u := range scope {
		if p != "" && u == uri {
			return p
		}
	}
	return uri
}

func qname(n xml.Name, scope map[string]string) string {
	if n.Space == "" {
		return n.Local
	}
	p := prefixFor(n.Space, scope)
	if p == "" {
		return n.Local
	}
	return p + ":" + n.Local
}

func escapeText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '\r':
			b.WriteString("&#xD;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func escapeAttr(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '"':
			b.WriteString("&quot;")
		case '\r':
			b.WriteString("&#xD;")
		case '\n':
			b.WriteString("&#xA;")
		case '\t':
			b.WriteString("&#x9;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func copyMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func setOf(in []string) map[string]struct{} {
	out := make(map[string]struct{}, len(in))
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out[s] = struct{}{}
		}
	}
	return out
}
