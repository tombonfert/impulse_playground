import { useEffect, useRef, useState } from 'react';
import { AppConfig, saveWarehouse } from '../api';

interface Props {
  warehouseId: string;
  onSaved: (cfg: AppConfig) => void;
  onClose: () => void;
}

// Small config overlay to point the app at a different SQL warehouse at runtime.
// Free-text warehouse id, pre-filled with the current value. Closes on backdrop
// click or Escape (same dismiss pattern as MultiSelect).
export default function WarehouseConfig({ warehouseId, onSaved, onClose }: Props) {
  const [value, setValue] = useState(warehouseId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    const wid = value.trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(wid)) {
      setError('Warehouse id must be 16 hexadecimal characters.');
      return;
    }
    setSaving(true);
    setError(null);
    saveWarehouse(wid)
      .then((cfg) => onSaved(cfg))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="config-overlay" onMouseDown={onClose}>
      <div className="config-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="config-head">
          <span className="config-title">SQL warehouse</span>
          <button type="button" className="config-x" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <label className="config-label" htmlFor="wh-id">
          Warehouse ID
        </label>
        <input
          id="wh-id"
          ref={inputRef}
          className="config-input"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. 862f1d757f0424f7"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <p className="config-hint">
          The warehouse the app queries. Find the ID in its connection details (16
          hex characters). Applies immediately for this session.
        </p>
        {error && <div className="config-err">{error}</div>}
        <div className="config-actions">
          <button type="button" className="config-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="config-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
