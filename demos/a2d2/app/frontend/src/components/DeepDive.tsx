import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EventReport,
  EventRow,
  Markers,
  StatRow,
  TSResponse,
  clipUrl,
  cssColor,
  fetchMarkers,
  fetchReport,
  fetchStats,
  fmtTs,
} from '../api';
import TimeseriesPanel from './TimeseriesPanel';
import ClipPlayer from './ClipPlayer';
import FrameViewer from './FrameViewer';
import KpiCards, { computeKpis } from './KpiCards';
import MiniMap from './MiniMap';

// Full-width deep dive for one Impulse event instance: event-specific signal panels + KPIs
// (from backend/reports.py) on the left; clip / camera frame, KPI cards, map, AI verdict and
// the Impulse per-event statistics on the right — all on ONE shared playhead.

const CONTEXT_PAD_S = 15; // signals fetched around the event

export function Verdict({ event }: { event: EventRow }) {
  if (event.is_relevant == null) return null;
  return (
    <div className={`verdict-box ${event.is_relevant ? 'verdict-yes' : 'verdict-no'}`}>
      <div className="verdict-head">
        {event.is_relevant ? '✓ Relevant' : '⚠ Likely false positive'}
        {event.relevance_score != null && <span className="verdict-conf">confidence {event.relevance_score.toFixed(2)}</span>}
      </div>
      {event.relevance_reason && <div className="verdict-reason">{event.relevance_reason}</div>}
      <div className="verdict-src">AI verification (vision model on camera frames + telemetry)</div>
    </div>
  );
}

function StatsTable({ event }: { event: EventRow }) {
  const [stats, setStats] = useState<StatRow[]>([]);
  useEffect(() => {
    fetchStats(event.container_id, event.event_instance_id).then(setStats).catch(() => setStats([]));
  }, [event.container_id, event.event_instance_id]);
  const cols = ['min', 'mean', 'max'];
  // Hide channels without any value in this event (e.g. no pedestrian during a braking event).
  const rows = stats.filter((r) => cols.some((c) => typeof r[c] === 'number'));
  if (!rows.length) return <p className="hint">No Impulse statistics for this event.</p>;
  return (
    <table className="stats">
      <thead><tr><th>Channel</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.channel_name}>
            <td>{r.channel_name}</td>
            {cols.map((c) => <td key={c} className="num">{typeof r[c] === 'number' ? (r[c] as number).toFixed(2) : '—'}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DeepDive({ event, onBack }: { event: EventRow; onBack: () => void }) {
  const [report, setReport] = useState<EventReport | null>(null);
  const [markers, setMarkers] = useState<Markers | null>(null);
  const [series, setSeries] = useState<TSResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playheadS, setPlayheadS] = useState<number | null>(null);
  const [seek, setSeek] = useState<{ s: number; nonce: number } | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);

  const startS = (event.start_ts ?? 0) / 1e6;
  const endS = (event.end_ts ?? event.start_ts ?? 0) / 1e6;
  const band: [number, number] = [startS, endS];

  useEffect(() => {
    setReport(null);
    setSeries(null);
    setPlayheadS(null);
    fetchReport(event.container_id, event.event_instance_id).then(setReport).catch((e) => setError(String(e)));
    fetchMarkers(event.container_id).then(setMarkers).catch(() => setMarkers(null));
  }, [event.container_id, event.event_instance_id]);

  const windowS = useMemo<[number, number] | null>(() => {
    if (!markers) return null;
    const rs = markers.recording.start_s ?? startS - CONTEXT_PAD_S;
    const re = markers.recording.end_s ?? endS + CONTEXT_PAD_S;
    return [Math.max(rs, startS - CONTEXT_PAD_S), Math.min(re, endS + CONTEXT_PAD_S)];
  }, [markers, startS, endS]);

  // Seek from the signal side: move the playhead AND the video.
  const seekTo = (s: number) => {
    const c = windowS ? Math.min(windowS[1], Math.max(windowS[0], s)) : s;
    setPlayheadS(c);
    setSeek({ s: c, nonce: Date.now() + Math.random() });
  };

  const byName = useMemo(() => new Map((series?.channels ?? []).map((s) => [s.name, s])), [series]);
  const kpis = useMemo(() => (report ? computeKpis(report.kpis, byName, startS, endS) : []), [report, byName, startS, endS]);

  // Start on the report's key moment (e.g. peak deceleration), else the event start.
  const started = useRef(false);
  useEffect(() => { started.current = false; }, [event.container_id, event.event_instance_id]);
  useEffect(() => {
    if (started.current || !series || !report) return;
    started.current = true;
    const focus = report.focus != null ? kpis[report.focus] : null;
    seekTo(focus?.atS ?? startS);
  }, [series, report]); // eslint-disable-line react-hooks/exhaustive-deps

  // ←/→ step 0.1 s, shift = 1 s.
  const live = useRef({ playheadS, seekTo });
  live.current = { playheadS, seekTo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const ph = live.current.playheadS;
      if (ph == null) return;
      e.preventDefault();
      const d = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
      live.current.seekTo(Math.round((ph + d) * 10) / 10);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const others = (markers?.instances ?? []).filter((m) => m.event_instance_id !== event.event_instance_id);

  return (
    <div className="deep-dive">
      <div className="dd-head">
        <button className="back-btn" onClick={onBack}>← Map</button>
        <h2>
          <span className="dot" style={{ background: cssColor(event.event_name) }} />
          {event.event_name}
          <small>{report?.summary ?? event.event_description}</small>
        </h2>
        <span className="hint">
          {fmtTs(event.start_ts)} → {fmtTs(event.end_ts)} · {(endS - startS).toFixed(1)} s · {event.city ?? ''} {event.vehicle ?? ''}
        </span>
      </div>
      <div className="dd-body">
        <div className="dd-left">
          {error && <p className="err">{error}</p>}
          {report && windowS ? (
            <TimeseriesPanel
              containerId={event.container_id}
              groups={report.panels}
              markers={others}
              band={band}
              windowS={windowS}
              originS={startS}
              playheadS={playheadS}
              hoverSeek={!videoPlaying}
              onSeek={seekTo}
              onData={setSeries}
            />
          ) : (
            !error && <p className="hint">Loading…</p>
          )}
        </div>
        <aside className="dd-right">
          {event.has_clip ? (
            <ClipPlayer
              src={clipUrl(event)}
              recordingStartS={startS}
              recordingEndS={endS}
              offsetS={0}
              rotateDeg={0}
              trimEndS={0}
              seek={seek}
              onTime={setPlayheadS}
              onPlayingChange={setVideoPlaying}
            />
          ) : (
            <FrameViewer containerId={event.container_id} playheadS={playheadS} originS={startS} />
          )}
          <h4 className="col-title">Key figures — click to jump to the moment</h4>
          <KpiCards kpis={kpis} originS={startS} onSeek={seekTo} />
          {event.event_description && <p className="hint rule">Rule: {event.event_description}</p>}
          <Verdict event={event} />
          <MiniMap containerId={event.container_id} band={band} playheadS={playheadS} onSeek={seekTo} />
          <h4 className="col-title">Impulse statistics (within the event)</h4>
          <StatsTable event={event} />
        </aside>
      </div>
    </div>
  );
}
