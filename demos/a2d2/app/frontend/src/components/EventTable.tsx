import { useMemo, useState } from 'react';
import { EventRow, cssColor, fmtTs } from '../api';

interface Props {
  events: EventRow[];
  selected: EventRow | null;
  onSelect: (e: EventRow) => void;
}

type SortKey = 'event_name' | 'event_type' | 'city' | 'vehicle' | 'start_ts';

export default function EventTable({ events, selected, onSelect }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('start_ts');
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const rows = [...events];
    rows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [events, sortKey, asc]);

  const header = (label: string, key: SortKey) => (
    <th
      onClick={() => {
        if (sortKey === key) setAsc(!asc);
        else {
          setSortKey(key);
          setAsc(true);
        }
      }}
      className={sortKey === key ? 'sorted' : ''}
    >
      {label}
      {sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="table-wrap">
      <table className="events">
        <thead>
          <tr>
            {header('Event', 'event_name')}
            {header('Type', 'event_type')}
            {header('City', 'city')}
            {header('Vehicle', 'vehicle')}
            {header('Start', 'start_ts')}
            <th>Clip</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const isSel =
              selected &&
              selected.container_id === e.container_id &&
              selected.event_instance_id === e.event_instance_id;
            return (
              <tr
                key={`${e.container_id}-${e.event_instance_id}`}
                className={isSel ? 'sel' : ''}
                onClick={() => onSelect(e)}
              >
                <td>{e.event_name}</td>
                <td>
                  <span className="dot" style={{ background: cssColor(e.event_type) }} />
                  {e.event_type}
                </td>
                <td>{e.city ?? '—'}</td>
                <td>{e.vehicle ?? '—'}</td>
                <td className="ts">{fmtTs(e.start_ts)}</td>
                <td>{e.has_clip ? '🎬' : ''}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No events match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
