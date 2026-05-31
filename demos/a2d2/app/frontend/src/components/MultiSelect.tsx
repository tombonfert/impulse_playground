import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
}

// Lightweight multi-select dropdown (no dependency): a button showing the
// selection summary that opens a checkbox panel. Closes on outside click / Esc.
export default function MultiSelect({ label, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((s) => s !== o) : [...selected, o]);

  const summary =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <div className="filter-group" ref={ref}>
      <label>{label}</label>
      <div className="ms">
        <button
          type="button"
          className={`ms-button${open ? ' ms-open' : ''}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`ms-summary${selected.length ? '' : ' ms-placeholder'}`}>{summary}</span>
          <span className="ms-caret">{open ? '▴' : '▾'}</span>
        </button>
        {open && (
          <div className="ms-menu">
            {options.length === 0 && <div className="ms-empty">No options</div>}
            {options.map((o) => (
              <label key={o} className="ms-option">
                <input
                  type="checkbox"
                  checked={selected.includes(o)}
                  onChange={() => toggle(o)}
                />
                <span>{o}</span>
              </label>
            ))}
            {selected.length > 0 && (
              <button type="button" className="ms-clear" onClick={() => onChange([])}>
                Clear selection
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
