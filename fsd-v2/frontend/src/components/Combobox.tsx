import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, Search, X, Check } from 'lucide-react';

export interface ComboOption {
  value: string;
  label: string;
  sub?: string;     // secondary line (e.g. location / code)
  group?: string;   // optional optgroup-style heading
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  emptyText?: string;
  allowClear?: boolean;   // show a clear (×) affordance when something is selected
  ariaLabel?: string;
  className?: string;
}

// Single-select searchable combobox — a drop-in upgrade for a native <select>
// (with <optgroup>) that becomes unusable once a tenant has 100+ rooms or cost
// centers. Type to filter, ↑/↓ + Enter to pick, Escape to close. Backing data is
// filtered locally, so no server search endpoint is needed.
export function Combobox({ value, onChange, options, placeholder, emptyText, allowClear, ariaLabel, className }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      o.label.toLowerCase().includes(q)
      || (o.sub?.toLowerCase().includes(q) ?? false)
      || (o.group?.toLowerCase().includes(q) ?? false));
  }, [options, query]);

  useEffect(() => { setActive(0); }, [query, open]);

  // Close when focus leaves the widget.
  useEffect(() => {
    function onDown(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Fresh query + focus the search box each time the menu opens.
  useEffect(() => { if (open) { setQuery(''); inputRef.current?.focus(); } }, [open]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current.querySelectorAll('.combo-opt')[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(v: string) { onChange(v); setOpen(false); }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[active]) choose(matches[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }

  return (
    <div className={`combo${className ? ` ${className}` : ''}`} ref={boxRef}>
      <button type="button" className="combo-control" aria-label={ariaLabel}
              aria-haspopup="listbox" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}>
        <span className={`combo-value${selected ? '' : ' placeholder'}`}>
          {selected ? selected.label : (placeholder || '')}
        </span>
        {allowClear && selected
          ? <span className="combo-clear" role="button" aria-label="Clear"
                  onClick={(e) => { e.stopPropagation(); onChange(''); }}><X size={14} /></span>
          : <ChevronDown size={15} className="combo-chevron" />}
      </button>

      {open && (
        <div className="combo-menu" ref={menuRef} role="listbox">
          <div className="combo-search">
            <Search size={14} className="muted" />
            <input ref={inputRef} value={query} placeholder={placeholder || ''}
                   onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
          </div>
          <div className="combo-list">
            {matches.length === 0 && <div className="combo-empty">{emptyText || 'No matches'}</div>}
            {matches.map((o, i) => {
              const showGroup = o.group && o.group !== matches[i - 1]?.group;
              return (
                <div key={`${o.value}-${i}`}>
                  {showGroup && <div className="combo-group">{o.group}</div>}
                  <button type="button" role="option" aria-selected={o.value === value}
                          className={`combo-opt${i === active ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
                          onMouseEnter={() => setActive(i)} onClick={() => choose(o.value)}>
                    <span className="combo-opt-main">
                      <span className="combo-opt-label">{o.label}</span>
                      {o.sub && <span className="combo-opt-sub">{o.sub}</span>}
                    </span>
                    {o.value === value && <Check size={14} className="combo-opt-check" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
