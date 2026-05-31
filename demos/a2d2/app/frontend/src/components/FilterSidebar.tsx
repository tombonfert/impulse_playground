import { Filters, fmtTs } from '../api';
import MultiSelect from './MultiSelect';

export interface SelectedFilters {
  vehicle: string[];
  city: string[];
  event_name: string[];
  event_type: string[];
  start_ts: number | null;
  end_ts: number | null;
  verified_only: boolean;
}

interface Props {
  filters: Filters | null;
  selected: SelectedFilters;
  onChange: (s: SelectedFilters) => void;
}

export default function FilterSidebar({ filters, selected, onChange }: Props) {
  if (!filters) return <aside className="sidebar">Loading filters…</aside>;

  const set = (patch: Partial<SelectedFilters>) => onChange({ ...selected, ...patch });

  const min = filters.min_ts ?? 0;
  const max = filters.max_ts ?? 0;
  const hasRange = max > min;

  return (
    <aside className="sidebar">
      <h3>Filters</h3>
      <MultiSelect
        label="Vehicle"
        options={filters.vehicles}
        selected={selected.vehicle}
        onChange={(v) => set({ vehicle: v })}
      />
      <MultiSelect
        label="City"
        options={filters.cities}
        selected={selected.city}
        onChange={(v) => set({ city: v })}
      />
      <MultiSelect
        label="Event name"
        options={filters.event_names}
        selected={selected.event_name}
        onChange={(v) => set({ event_name: v })}
      />
      <MultiSelect
        label="Event type"
        options={filters.event_types}
        selected={selected.event_type}
        onChange={(v) => set({ event_type: v })}
      />

      <div className="filter-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={selected.verified_only}
            onChange={(e) => set({ verified_only: e.target.checked })}
          />
          <span>Verified only</span>
        </label>
      </div>

      {hasRange && (
        <div className="filter-group">
          <label>Time range</label>
          <div className="range-row">
            <span className="range-label">{fmtTs(selected.start_ts ?? min)}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={Math.max(Math.floor((max - min) / 1000), 1)}
              value={selected.start_ts ?? min}
              onChange={(e) =>
                set({ start_ts: Math.min(Number(e.target.value), selected.end_ts ?? max) })
              }
            />
          </div>
          <div className="range-row">
            <span className="range-label">{fmtTs(selected.end_ts ?? max)}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={Math.max(Math.floor((max - min) / 1000), 1)}
              value={selected.end_ts ?? max}
              onChange={(e) =>
                set({ end_ts: Math.max(Number(e.target.value), selected.start_ts ?? min) })
              }
            />
          </div>
        </div>
      )}

      <button
        className="reset"
        onClick={() =>
          onChange({
            vehicle: [],
            city: [],
            event_name: [],
            event_type: [],
            start_ts: filters.min_ts,
            end_ts: filters.max_ts,
            verified_only: false,
          })
        }
      >
        Reset
      </button>
    </aside>
  );
}
