// Typed API client matching backend/main.py exactly.

export interface Filters {
  event_names: string[];
  event_types: string[];
  cities: string[];
  vehicles: string[];
  min_ts: number | null;
  max_ts: number | null;
}

export interface EventRow {
  container_id: number;
  event_instance_id: number;
  event_name: string;
  event_type: string;
  city: string | null;
  vehicle: string | null;
  start_ts: number | null;
  end_ts: number | null;
  lat: number | null;
  lon: number | null;
  has_clip: boolean;
  // VLM-as-judge relevance verdict (null until the verification job has run).
  is_relevant: boolean | null;
  relevance_score: number | null;
  relevance_reason: string | null;
}

// stats rows are pivoted: {channel_name, <agg_label>: number, ...}
export type StatRow = { channel_name: string } & Record<string, number | string | null>;

// route points: [lat, lon, ts]
export type RoutePoint = [number, number, number];

export interface EventQuery {
  vehicle?: string[];
  city?: string[];
  event_name?: string[];
  event_type?: string[];
  start_ts?: number | null;
  end_ts?: number | null;
  verified_only?: boolean;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function fetchFilters(): Promise<Filters> {
  return getJSON<Filters>('/api/filters');
}

export function fetchEvents(q: EventQuery): Promise<EventRow[]> {
  const p = new URLSearchParams();
  const csv = (k: keyof EventQuery, vals?: string[]) => {
    if (vals && vals.length) p.set(k, vals.join(','));
  };
  csv('vehicle', q.vehicle);
  csv('city', q.city);
  csv('event_name', q.event_name);
  csv('event_type', q.event_type);
  if (q.start_ts != null) p.set('start_ts', String(q.start_ts));
  if (q.end_ts != null) p.set('end_ts', String(q.end_ts));
  if (q.verified_only) p.set('verified_only', 'true');
  const qs = p.toString();
  return getJSON<EventRow[]>(`/api/events${qs ? `?${qs}` : ''}`);
}

export function fetchStats(cid: number, eiid: number): Promise<StatRow[]> {
  return getJSON<StatRow[]>(`/api/events/${cid}/${eiid}/stats`);
}

export function fetchRoute(cid: number): Promise<RoutePoint[]> {
  return getJSON<RoutePoint[]>(`/api/route/${cid}`);
}

export function clipUrl(ev: EventRow): string {
  return `/api/events/${ev.container_id}/${ev.event_instance_id}/clip?event_name=${encodeURIComponent(
    ev.event_name,
  )}`;
}

// Deterministic categorical palette (RGB triples for deck.gl).
const PALETTE: [number, number, number][] = [
  [228, 26, 28],
  [55, 126, 184],
  [77, 175, 74],
  [152, 78, 163],
  [255, 127, 0],
  [166, 86, 40],
  [247, 129, 191],
  [153, 153, 153],
  [23, 190, 207],
  [188, 189, 34],
];

// Stable color mapping per event_name. The known event names are assigned a
// fixed palette slot so colors are deterministic across renders and reloads;
// any unknown name falls back to a deterministic hash into the palette.
const NAME_ORDER: string[] = [
  'emergency_braking',
  'imminent_rear_end',
  'pedestrian_in_path',
  'sharp_cornering',
  'cyclist_close_encounter',
  'pedestrian_near_miss',
  'evasive_maneuver',
  'vru_brake_reaction',
  'vehicle_moving',
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForName(name: string): [number, number, number] {
  const idx = NAME_ORDER.indexOf(name);
  if (idx >= 0) return PALETTE[idx % PALETTE.length];
  return PALETTE[hashString(name) % PALETTE.length];
}

export function cssColor(name: string): string {
  const [r, g, b] = colorForName(name);
  return `rgb(${r},${g},${b})`;
}

// Best-effort timestamp -> Date. The fact table stores epoch in micro- or
// nanoseconds; detect magnitude and normalize to ms for display only.
export function tsToDate(ts: number | null): Date | null {
  if (ts == null) return null;
  let ms = ts;
  if (ts > 1e17) ms = ts / 1e6; // nanoseconds
  else if (ts > 1e14) ms = ts / 1e3; // microseconds
  else if (ts > 1e11) ms = ts; // milliseconds
  else ms = ts * 1000; // seconds
  return new Date(ms);
}

export function fmtTs(ts: number | null): string {
  const d = tsToDate(ts);
  return d ? d.toISOString().replace('T', ' ').replace('.000Z', 'Z') : '—';
}
