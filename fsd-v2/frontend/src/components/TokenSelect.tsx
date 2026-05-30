import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

export interface TokenOption {
  value: string;       // stored identifier (username / location name)
  label: string;       // primary display text
  sub?: string;        // secondary line (e.g. email)
}

interface Props {
  options: TokenOption[];
  value: string[];                       // selected option values
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;                    // shown when a query matches nothing
  // Allow free-text values not present in `options` (e.g. an email that has no
  // user row yet). Off by default — pickers should constrain to real entities.
  allowCustom?: boolean;
}

// Searchable multi-select with dismissible pill chips. Replaces the
// error-prone "type a comma-separated list" inputs across the admin pages:
// the admin types to filter a real address book of users / locations and
// clicks to add. Backing data is fetched once by the caller and filtered
// locally, so it works without a dedicated server search endpoint.
export function TokenSelect({ options, value, onChange, placeholder, emptyText, allowCustom }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byValue = useMemo(() => {
    const m = new Map<string, TokenOption>();
    options.forEach((o) => m.set(o.value, o));
    return m;
  }, [options]);

  // Candidates = unselected options whose label/sub/value match the query.
  const matches = useMemo(() => {
    const sel = new Set(value);
    const q = query.trim().toLowerCase();
    return options
      .filter((o) => !sel.has(o.value))
      .filter((o) => !q
        || o.label.toLowerCase().includes(q)
        || o.value.toLowerCase().includes(q)
        || (o.sub?.toLowerCase().includes(q) ?? false))
      .slice(0, 50);
  }, [options, value, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Close the dropdown when focus leaves the whole widget.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function add(v: string) {
    if (!v || value.includes(v)) return;
    onChange([...value, v]);
    setQuery('');
    setOpen(true);
    inputRef.current?.focus();
  }
  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[active]) add(matches[active].value);
      else if (allowCustom && query.trim()) add(query.trim());
    } else if (e.key === 'Backspace' && !query && value.length) {
      removeAt(value.length - 1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="tokensel" ref={boxRef}>
      <div className="tokensel-box" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        {value.map((v, i) => {
          const o = byValue.get(v);
          return (
            <span key={v} className="tokensel-chip">
              {o?.label ?? v}
              <button type="button" aria-label="Remove" onClick={(e) => { e.stopPropagation(); removeAt(i); }}>
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={query}
          placeholder={value.length ? '' : (placeholder || '')}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (query.trim() || matches.length > 0) && (
        <div className="tokensel-menu">
          {matches.map((o, i) => (
            <button
              type="button"
              key={o.value}
              className={`tokensel-opt ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(o.value)}
            >
              <span className="tokensel-opt-label">{o.label}</span>
              {o.sub && <span className="tokensel-opt-sub">{o.sub}</span>}
            </button>
          ))}
          {matches.length === 0 && allowCustom && query.trim() && (
            <button type="button" className="tokensel-opt active" onClick={() => add(query.trim())}>
              <span className="tokensel-opt-label">Add “{query.trim()}”</span>
            </button>
          )}
          {matches.length === 0 && !allowCustom && (
            <div className="tokensel-empty">{emptyText || 'No matches'}</div>
          )}
        </div>
      )}
    </div>
  );
}
