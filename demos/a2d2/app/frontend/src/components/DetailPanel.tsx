import { useEffect, useMemo, useState } from 'react';
import { EventRow, StatRow, clipUrl, cssColor, fetchStats, fmtTs } from '../api';

interface Props {
  event: EventRow | null;
}

// Pick the numeric aggregation column to chart: prefer mean, else first numeric.
function pickMetric(rows: StatRow[]): string | null {
  const keys = new Set<string>();
  rows.forEach((r) =>
    Object.keys(r).forEach((k) => {
      if (k !== 'channel_name' && typeof r[k] === 'number') keys.add(k);
    }),
  );
  if (keys.has('mean')) return 'mean';
  if (keys.has('avg')) return 'avg';
  return keys.size ? Array.from(keys)[0] : null;
}

export default function DetailPanel({ event }: Props) {
  const [stats, setStats] = useState<StatRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!event) {
      setStats([]);
      return;
    }
    setLoading(true);
    fetchStats(event.container_id, event.event_instance_id)
      .then(setStats)
      .catch(() => setStats([]))
      .finally(() => setLoading(false));
  }, [event?.container_id, event?.event_instance_id]);

  const metric = useMemo(() => pickMetric(stats), [stats]);
  const aggCols = useMemo(() => {
    const cols = new Set<string>();
    stats.forEach((r) =>
      Object.keys(r).forEach((k) => k !== 'channel_name' && cols.add(k)),
    );
    return Array.from(cols);
  }, [stats]);

  const maxAbs = useMemo(() => {
    if (!metric) return 1;
    return (
      Math.max(
        ...stats.map((r) => Math.abs(Number(r[metric] ?? 0))),
        1e-9,
      ) || 1
    );
  }, [stats, metric]);

  if (!event) {
    return (
      <section className="detail">
        <p className="hint">Select an event to see its clip, stats, and metadata.</p>
      </section>
    );
  }

  return (
    <section className="detail">
      <h3>
        {event.event_name}{' '}
        <span className="dot" style={{ background: cssColor(event.event_type) }} />
        <small>{event.event_type}</small>
      </h3>

      <div className="meta">
        <div>
          <span>City</span>
          {event.city ?? '—'}
        </div>
        <div>
          <span>Vehicle</span>
          {event.vehicle ?? '—'}
        </div>
        <div>
          <span>Container</span>
          {event.container_id}
        </div>
        <div>
          <span>Instance</span>
          {event.event_instance_id}
        </div>
        <div className="wide">
          <span>Start</span>
          {fmtTs(event.start_ts)}
        </div>
        <div className="wide">
          <span>End</span>
          {fmtTs(event.end_ts)}
        </div>
      </div>

      {event.has_clip ? (
        <video
          key={`${event.container_id}-${event.event_instance_id}`}
          className="clip"
          controls
          src={clipUrl(event)}
        />
      ) : (
        <p className="hint">No clip available for this event.</p>
      )}

      <h4>Channel statistics</h4>
      {loading && <p className="hint">Loading stats…</p>}
      {!loading && stats.length === 0 && <p className="hint">No statistics.</p>}
      {!loading && stats.length > 0 && (
        <>
          {metric && (
            <div className="bars">
              {stats.map((r) => {
                const v = Number(r[metric] ?? 0);
                const w = (Math.abs(v) / maxAbs) * 100;
                return (
                  <div className="bar-row" key={r.channel_name}>
                    <span className="bar-label" title={r.channel_name}>
                      {r.channel_name}
                    </span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${w}%` }} />
                    </span>
                    <span className="bar-val">{v.toFixed(2)}</span>
                  </div>
                );
              })}
              <div className="bar-caption">bars show “{metric}”</div>
            </div>
          )}
          <table className="stats">
            <thead>
              <tr>
                <th>Channel</th>
                {aggCols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.map((r) => (
                <tr key={r.channel_name}>
                  <td>{r.channel_name}</td>
                  {aggCols.map((c) => (
                    <td key={c} className="num">
                      {typeof r[c] === 'number' ? (r[c] as number).toFixed(3) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
