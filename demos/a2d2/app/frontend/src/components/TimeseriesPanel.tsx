import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {
  ChannelInfo,
  EventMarker,
  TSChannelDef,
  TSGroup,
  TSResponse,
  TSSeries,
  colorForName,
  fetchTimeseries,
  searchChannels,
} from '../api';

// Event deep dive: time-synced panels over the Impulse silver channels (bus + perception)
// around one event. One shared PLAYHEAD (epoch s) ties everything together:
//   - HOVER a chart (or click it), drag the timeline, ←/→   -> onSeek (clip / camera frame follow)
//   - clip playback / its scrubber                          -> playheadS prop
// Drag inside a chart zooms (all panels share the x-range). The x-axis is seconds
// relative to the event start (negative = before the event).

const COLORS = ['#4a9eff', '#ff5c5c', '#4cd17a', '#ffa64d', '#b28cff', '#d6a77a', '#ff8ad8', '#3fd3e0'];
const PLAYHEAD = '#ffd54a';
const AXIS: Partial<uPlot.Axis> = {
  stroke: '#8b97a6',
  font: '11px sans-serif',
  labelFont: '11px sans-serif',
  grid: { stroke: '#2a3340', width: 1 },
  ticks: { stroke: '#2a3340', width: 1 },
};
const COLUMN_TITLES: Record<string, string> = { event: 'Event signals', context: 'Vehicle context', custom: 'Custom channels' };
// Camera-derived channels (counts, distances; ~1 fps, null when nothing is detected) and
// derived:* channels are sparse -> stepped AND with point markers so isolated samples stay
// visible; high-rate bus signals -> plain lines.
const isPerception = (name: string) => /^(detected_|ahead_)|_distance_m$|^derived:/.test(name);
const short = (name: string) => name.split('_').map((w) => w[0]).join('').toUpperCase();

interface Props {
  containerId: string;
  groups: TSGroup[];
  markers: EventMarker[]; // other events of this drive
  band: [number, number]; // selected event window, epoch s
  windowS: [number, number]; // fetched window, epoch s
  originS: number; // x = 0 (event start), epoch s
  playheadS: number | null;
  hoverSeek: boolean;
  onSeek: (epochS: number) => void;
  onData?: (resp: TSResponse) => void;
}

interface Aligned {
  x: number[];
  ys: (number | null)[][];
}

// Union of all sample times; each series is sampled as-of (last value at or before t),
// null outside its own range — fine for both bus signals and frame-rate counts.
function align(series: TSSeries[], origin: number): Aligned {
  const times = Array.from(new Set(series.flatMap((s) => s.t))).sort((a, b) => a - b);
  const ys = series.map((s) => {
    const out: (number | null)[] = new Array(times.length).fill(null);
    let j = -1;
    for (let i = 0; i < times.length; i += 1) {
      while (j + 1 < s.t.length && s.t[j + 1] <= times[i] + 1e-9) j += 1;
      if (j >= 0 && times[i] <= s.t[s.t.length - 1] + 1e-9) out[i] = s.v[j];
    }
    return out;
  });
  return { x: times.map((t) => t - origin), ys };
}

function scaled(s: TSSeries, def: TSChannelDef): TSSeries {
  if (!def.scale || def.scale === 1) return s;
  return { ...s, v: s.v.map((v) => (v == null ? null : v * (def.scale as number))) };
}

interface Shared {
  plots: Set<uPlot>;
  syncing: boolean;
}

function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [w, setW] = useState(900);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => setW(Math.max(300, Math.floor(entries[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const fmtRel = (v: number | null) => (v == null ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} s`);

// Pointer handling (uPlot's built-in drag-zoom is disabled — its synced selection made plain
// clicks zoom): HOVER = SEEK (rAF-throttled; off while the clip plays), press+release within
// CLICK_PX = SEEK, horizontal drag beyond CLICK_PX = ZOOM (shared x-range).
const CLICK_PX = 6;

function seekOrZoom(u: uPlot, onSeekVal: (x: number) => void, onZoomVal: (a: number, b: number) => void, hoverEnabled: () => boolean) {
  const over = u.over;
  const band = document.createElement('div');
  band.className = 'ts-sel';
  over.appendChild(band);
  let x0: number | null = null;
  let hoverX: number | null = null;
  let raf = 0;
  const rel = (e: MouseEvent) => {
    const r = over.getBoundingClientRect();
    return Math.min(r.width, Math.max(0, e.clientX - r.left));
  };
  const hover = (e: MouseEvent) => {
    if (x0 != null || !hoverEnabled()) return;
    hoverX = rel(e);
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (hoverX != null) onSeekVal(u.posToVal(hoverX, 'x'));
      });
    }
  };
  const move = (e: MouseEvent) => {
    if (x0 == null) return;
    const x1 = rel(e);
    if (Math.abs(x1 - x0) > CLICK_PX) {
      band.style.display = 'block';
      band.style.left = `${Math.min(x0, x1)}px`;
      band.style.width = `${Math.abs(x1 - x0)}px`;
    } else band.style.display = 'none';
  };
  const up = (e: MouseEvent) => {
    if (x0 == null) return;
    const x1 = rel(e);
    const start = x0;
    x0 = null;
    band.style.display = 'none';
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (Math.abs(x1 - start) > CLICK_PX) onZoomVal(u.posToVal(Math.min(start, x1), 'x'), u.posToVal(Math.max(start, x1), 'x'));
    else onSeekVal(u.posToVal(start, 'x'));
  };
  const down = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    x0 = rel(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  over.addEventListener('mousedown', down);
  over.addEventListener('mousemove', hover);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    over.removeEventListener('mousedown', down);
    over.removeEventListener('mousemove', hover);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    band.remove();
  };
}

function showPlayhead(u: uPlot, playheadS: number | null, origin: number) {
  if (playheadS == null || u.over.matches(':hover')) return;
  const left = u.valToPos(playheadS - origin, 'x');
  if (left >= 0 && left <= u.over.clientWidth) u.setCursor({ left, top: 10 }, false);
}

// ---- chart ----------------------------------------------------------------------
interface ChartProps {
  title: string;
  defs: TSChannelDef[];
  data: Aligned;
  units: string[];
  width: number;
  origin: number;
  xRange: [number, number];
  shared: Shared;
  band: [number, number];
  markers: EventMarker[];
  playheadS: number | null;
  hoverSeek: boolean;
  onXRange: (r: [number, number]) => void;
  onSeek: (epochS: number) => void;
}

function Chart(props: ChartProps) {
  const { title, defs, data, units, width, origin, xRange, shared, band, markers, playheadS } = props;
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    if (!el.current) return undefined;
    const hasRight = defs.some((d) => d.axis === 'right');
    const opts: uPlot.Options = {
      width,
      height: 165,
      cursor: {
        sync: { key: 'a2d2-deep-dive', setSeries: false },
        drag: { x: false, y: false, setScale: false },
        bind: { dblclick: () => null },
      },
      scales: { x: { time: false, min: xRange[0], max: xRange[1] } },
      legend: { live: true },
      axes: [
        { label: 'time relative to event start [s]', size: 34, labelSize: 14, ...AXIS },
        { scale: 'left', size: 56, ...AXIS },
        ...(hasRight ? [{ scale: 'right', side: 1, size: 56, ...AXIS, grid: { show: false } } as uPlot.Axis] : []),
      ],
      series: [
        { label: 't', value: (_u, v) => fmtRel(v) },
        ...defs.map((d, i) => ({
          label: d.label,
          scale: d.axis === 'right' ? 'right' : 'left',
          stroke: COLORS[i % COLORS.length],
          width: 1.6,
          spanGaps: false,
          points: isPerception(d.name) ? { show: true, size: 5 } : { show: false },
          ...(isPerception(d.name) ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
          value: (_u: uPlot, v: number | null) =>
            v == null ? '—' : `${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}${units[i] && !d.label.includes('[') ? ` ${units[i]}` : ''}`,
        })),
      ],
      hooks: {
        drawClear: [
          (u) => {
            const b = live.current.band;
            const x0 = Math.max(u.valToPos(b[0] - live.current.origin, 'x', true), u.bbox.left);
            const x1 = Math.min(u.valToPos(b[1] - live.current.origin, 'x', true), u.bbox.left + u.bbox.width);
            if (x1 <= x0) return;
            u.ctx.save();
            u.ctx.fillStyle = 'rgba(214, 39, 40, 0.09)';
            u.ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
            u.ctx.restore();
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            const dpr = devicePixelRatio;
            const inside = (x: number) => x >= u.bbox.left && x <= u.bbox.left + u.bbox.width;
            const vline = (x: number, color: string, dash: number[], w: number) => {
              ctx.strokeStyle = color;
              ctx.setLineDash(dash);
              ctx.lineWidth = w;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
            };
            ctx.save();
            ctx.font = `${10 * dpr}px sans-serif`;
            for (const m of live.current.markers) {
              const x = u.valToPos(m.start_s - live.current.origin, 'x', true);
              if (!inside(x)) continue;
              const [r, g, b] = colorForName(m.event_name);
              vline(x, `rgb(${r},${g},${b})`, [4 * dpr, 3 * dpr], 1.2 * dpr);
              ctx.fillStyle = `rgb(${r},${g},${b})`;
              ctx.fillText(short(m.event_name), x + 3 * dpr, u.bbox.top + 11 * dpr);
            }
            const ph = live.current.playheadS;
            if (ph != null) {
              const x = u.valToPos(ph - live.current.origin, 'x', true);
              if (inside(x)) vline(x, PLAYHEAD, [], 2 * dpr);
            }
            ctx.restore();
          },
        ],
        setScale: [
          (u, key) => {
            if (key !== 'x' || shared.syncing) return;
            const { min, max } = u.scales.x;
            if (min == null || max == null) return;
            shared.syncing = true;
            shared.plots.forEach((p) => p !== u && p.setScale('x', { min, max }));
            shared.syncing = false;
            live.current.onXRange([min, max]);
          },
        ],
      },
    };
    const u = new uPlot(opts, [data.x, ...data.ys] as uPlot.AlignedData, el.current);
    plot.current = u;
    shared.plots.add(u);
    const off = seekOrZoom(
      u,
      (x) => live.current.onSeek(live.current.origin + x),
      (a, b) => live.current.onXRange([a, b]),
      () => live.current.hoverSeek,
    );
    const leave = () => setTimeout(() => showPlayhead(u, live.current.playheadS, live.current.origin), 0);
    u.over.addEventListener('mouseleave', leave);
    return () => {
      off();
      u.over.removeEventListener('mouseleave', leave);
      shared.plots.delete(u);
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs.map((d) => d.name).join('|')]);

  useEffect(() => { plot.current?.setData([data.x, ...data.ys] as uPlot.AlignedData, false); plot.current?.redraw(); }, [data]);
  useEffect(() => { plot.current?.setSize({ width, height: 165 }); }, [width]);
  useEffect(() => {
    const u = plot.current;
    if (!u || shared.syncing) return;
    if (u.scales.x.min !== xRange[0] || u.scales.x.max !== xRange[1]) u.setScale('x', { min: xRange[0], max: xRange[1] });
  }, [xRange, shared]);
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    u.redraw(false);
    showPlayhead(u, playheadS, origin);
  }, [band, markers, playheadS, origin]);

  return (
    <div className="ts-chart">
      <div className="ts-title">{title}</div>
      <div ref={el} />
    </div>
  );
}

// ---- timeline scrubber (fetched window, event band, other events, zoom box, playhead) ----
function Timeline({ width, origin, lo, hi, band, markers, xRange, playheadS, onSeek }: {
  width: number; origin: number; lo: number; hi: number; band: [number, number]; markers: EventMarker[];
  xRange: [number, number]; playheadS: number | null; onSeek: (s: number) => void;
}) {
  const L = 8;
  const W = Math.max(50, width - 2 * L);
  const sx = (rel: number) => L + ((rel - lo) / (hi - lo || 1)) * W;
  const dragging = useRef(false);
  const seekAt = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(origin + Math.min(hi, Math.max(lo, lo + ((e.clientX - r.left - L) / W) * (hi - lo))));
  };
  const step = hi - lo > 40 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const clamp = (v: number) => Math.min(hi, Math.max(lo, v));
  const ph = playheadS != null ? playheadS - origin : null;
  return (
    <svg className="timeline" width={width} height={40}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAt(e); }}
      onPointerMove={(e) => { if (dragging.current) seekAt(e); }}
      onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}>
      <rect x={L} y={8} width={W} height={14} rx={3} fill="#1d242d" stroke="#2a3340" />
      {markers.map((m) => {
        const [r, g, b] = colorForName(m.event_name);
        const a = clamp(m.start_s - origin);
        const z = clamp(m.end_s - origin);
        return z > a ? (
          <rect key={`${m.event_name}-${m.event_instance_id}`} x={sx(a)} y={8} width={Math.max(2, sx(z) - sx(a))} height={14}
            fill={`rgba(${r},${g},${b},0.35)`}><title>{m.event_name}</title></rect>
        ) : null;
      })}
      <rect x={sx(clamp(band[0] - origin))} y={8} height={14} fill="rgba(255,92,92,0.65)"
        width={Math.max(2, sx(clamp(band[1] - origin)) - sx(clamp(band[0] - origin)))}><title>selected event</title></rect>
      <rect x={sx(clamp(xRange[0]))} y={6} height={18} rx={3} fill="none" stroke="#4a9eff" strokeWidth={1.2}
        width={Math.max(2, sx(clamp(xRange[1])) - sx(clamp(xRange[0])))} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={22} y2={26} stroke="#8b97a6" />
          <text x={sx(t)} y={36} textAnchor="middle" className="lane-axis">{t > 0 ? `+${t}` : t} s</text>
        </g>
      ))}
      {ph != null && ph >= lo && ph <= hi && (
        <g>
          <line x1={sx(ph)} x2={sx(ph)} y1={2} y2={28} stroke={PLAYHEAD} strokeWidth={2.5} />
          <circle cx={sx(ph)} cy={4} r={4} fill={PLAYHEAD} />
        </g>
      )}
    </svg>
  );
}

// ---- panel ---------------------------------------------------------------------
export default function TimeseriesPanel({ containerId, groups, markers, band, windowS, originS, playheadS, hoverSeek, onSeek, onData }: Props) {
  const [custom, setCustom] = useState<TSChannelDef[]>([]);
  const [resp, setResp] = useState<TSResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lo = windowS[0] - originS;
  const hi = windowS[1] - originS;
  const eventRange = (): [number, number] => [Math.max(lo, -2), Math.min(hi, band[1] - originS + 2)];
  const [xRange, setXRange] = useState<[number, number]>(eventRange);
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const shared = useRef<Shared>({ plots: new Set(), syncing: false }).current;

  const allGroups = useMemo<TSGroup[]>(
    () => (custom.length ? [...groups, { id: 'custom', column: 'custom', title: 'Custom channels', channels: custom }] : groups),
    [groups, custom],
  );
  const names = useMemo(() => Array.from(new Set(allGroups.flatMap((g) => g.channels.map((c) => c.name)))), [allGroups]);

  useEffect(() => {
    if (!names.length) return;
    setError(null);
    fetchTimeseries(containerId, names, windowS[0], windowS[1])
      .then((r) => { setResp(r); onData?.(r); })
      .catch((e) => setError(String(e)));
  }, [containerId, names.join('|'), windowS[0], windowS[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const prepared = useMemo(() => {
    const byName = new Map((resp?.channels ?? []).map((s) => [s.name, s]));
    return new Map(allGroups.map((g) => {
      const series = g.channels.map((c) => scaled(byName.get(c.name) ?? { name: c.name, unit: '', t: [], v: [] }, c));
      return [g.id, { data: align(series, originS), units: series.map((x) => x.unit) }];
    }));
  }, [resp, allGroups, originS]);

  const others = markers.filter((m) => m.end_s >= windowS[0] && m.start_s <= windowS[1]);
  const twoCol = width >= 1000;
  const colW = twoCol ? Math.floor((width - 16) / 2) : width;
  const columns: string[][] = twoCol ? [['event', 'custom'], ['context']] : [['event', 'context', 'custom']];
  const ph = playheadS != null ? playheadS - originS : null;

  return (
    <div className="ts-panel" ref={wrap}>
      <div className="ts-toolbar">
        <span className="playhead-label">
          ⏱ {ph != null ? fmtRel(ph) : '—'}
          <small>{playheadS != null ? `${new Date(playheadS * 1000).toISOString().slice(11, 23)} UTC` : ''}</small>
        </span>
        <span className="hint">
          {hoverSeek ? 'Hover the charts to scrub the video' : 'Video playing — click a chart to seek'} · drag in a chart to zoom · ←/→ = ±0.1 s
        </span>
        <button className="small-btn" onClick={() => setXRange([lo, hi])}>Wide context</button>
        <button className="small-btn" onClick={() => setXRange(eventRange())}>Event window</button>
        <ChannelPicker containerId={containerId} onAdd={(c) => setCustom((cs) => (cs.some((x) => x.name === c.name) ? cs : [...cs, c]))} />
      </div>
      <Timeline width={width} origin={originS} lo={lo} hi={hi} band={band} markers={others} xRange={xRange} playheadS={playheadS} onSeek={onSeek} />
      {custom.length > 0 && (
        <div className="chips">
          {custom.map((c) => (
            <span key={c.name} className="chip" title={c.name}>
              {c.label}
              <button onClick={() => setCustom((cs) => cs.filter((x) => x.name !== c.name))} aria-label="remove">×</button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {!resp && !error && <p className="hint">Loading signals…</p>}
      {resp && (
        <div className={twoCol ? 'ts-cols two' : 'ts-cols'}>
          {columns.map((cols) => (
            <div className="ts-col" key={cols.join('-')} style={{ width: colW }}>
              {cols.map((c) => {
                const gs = allGroups.filter((g) => (g.column ?? 'event') === c);
                if (!gs.length) return null;
                return (
                  <div key={c}>
                    <h4 className="col-title">{COLUMN_TITLES[c] ?? c}</h4>
                    {gs.map((g) => {
                      const pg = prepared.get(g.id);
                      return pg ? (
                        <Chart key={g.id} title={g.title} defs={g.channels} data={pg.data} units={pg.units} width={colW - 18}
                          origin={originS} xRange={xRange} shared={shared} band={band} markers={others} playheadS={playheadS}
                          hoverSeek={hoverSeek} onXRange={setXRange} onSeek={onSeek} />
                      ) : null;
                    })}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelPicker({ containerId, onAdd }: { containerId: string; onAdd: (c: TSChannelDef) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ChannelInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      return undefined;
    }
    const h = setTimeout(() => { searchChannels(containerId, q).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(h);
  }, [q, containerId]);
  return (
    <div className="picker">
      <input placeholder="+ add any channel…" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && hits.length > 0 && (
        <ul className="picker-list">
          {hits.map((h) => (
            <li key={h.channel_name} onMouseDown={() => {
              onAdd({ name: h.channel_name, label: `${h.channel_name}${h.unit ? ` [${h.unit}]` : ''}` });
              setQ('');
              setOpen(false);
            }}>
              <span>{h.channel_name}</span>
              <small>{h.unit || ''} {h.sample_count != null ? `· ${h.sample_count} samples` : ''}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
