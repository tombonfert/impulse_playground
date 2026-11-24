// Typed API client matching backend/main.py exactly.

export interface Filters {
  event_names: string[];
  event_types: string[];
  cities: string[];
  vehicles: string[];
  min_ts: number | null;
  max_ts: number | null;
}

// container_id / event_instance_id are transported as strings (64-bit ids exceed JS's 2^53 precision).
export interface EventRow {
  container_id: string;
  event_instance_id: string;
  event_name: string;
  event_type: string;
  event_description: string | null;
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

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the backend's detail message when present (e.g. validation errors).
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.detail) detail = String(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

// Runtime app configuration (the SQL warehouse the app queries).
export interface AppConfig {
  warehouse_id: string;
  http_path: string;
}

export function fetchConfig(): Promise<AppConfig> {
  return getJSON<AppConfig>('/api/config');
}

export function saveWarehouse(warehouseId: string): Promise<AppConfig> {
  return postJSON<AppConfig>('/api/config', { warehouse_id: warehouseId });
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

export function fetchStats(cid: string, eiid: string): Promise<StatRow[]> {
  return getJSON<StatRow[]>(`/api/events/${cid}/${eiid}/stats`);
}

export function fetchRoute(cid: string): Promise<RoutePoint[]> {
  return getJSON<RoutePoint[]>(`/api/route/${cid}`);
}

export function clipUrl(ev: EventRow): string {
  return `/api/events/${ev.container_id}/${ev.event_instance_id}/clip?event_name=${encodeURIComponent(
    ev.event_name,
  )}`;
}

// ---- Event deep dive -----------------------------------------------------------
export interface TSChannelDef {
  name: string;
  label: string;
  axis?: 'right';
  scale?: number;
}
export interface TSGroup {
  id: string;
  title: string;
  column?: 'event' | 'context' | 'custom';
  channels: TSChannelDef[];
}
export interface KpiDef {
  label: string;
  channel: string;
  // min | max | max_abs | mean | first | last | delta | range | at_min_of:<ch> | at_max_of:<ch>
  agg: string;
  unit: string;
  help: string;
  digits: number;
}
export interface EventReport {
  event_name: string;
  event_description: string | null;
  summary: string;
  panels: TSGroup[];
  kpis: KpiDef[];
  focus: number | null;
}
export interface TSSeries {
  name: string;
  unit: string;
  t: number[]; // epoch seconds
  v: (number | null)[];
}
export interface TSResponse {
  channels: TSSeries[];
  start_s: number;
  end_s: number;
}
export interface EventMarker {
  event_name: string;
  event_instance_id: string;
  start_s: number;
  end_s: number;
}
export interface Markers {
  recording: { start_s: number | null; end_s: number | null };
  instances: EventMarker[];
}
export interface ChannelInfo {
  channel_name: string;
  unit: string | null;
  sample_count: number | null;
  min: number | null;
  max: number | null;
}

export function fetchReport(cid: string, eiid: string): Promise<EventReport> {
  return getJSON<EventReport>(`/api/events/${cid}/${eiid}/report`);
}
export function fetchTimeseries(cid: string, channels: string[], startS: number, endS: number): Promise<TSResponse> {
  const p = new URLSearchParams({ channels: channels.join(','), start_s: String(startS), end_s: String(endS) });
  return getJSON<TSResponse>(`/api/containers/${cid}/timeseries?${p.toString()}`);
}
export function fetchMarkers(cid: string): Promise<Markers> {
  return getJSON<Markers>(`/api/containers/${cid}/markers`);
}
export function searchChannels(cid: string, q: string): Promise<ChannelInfo[]> {
  return getJSON<ChannelInfo[]>(`/api/containers/${cid}/channels?q=${encodeURIComponent(q)}`);
}
export function frameUrl(cid: string, epochS: number): string {
  return `/api/containers/${cid}/frame?t=${epochS.toFixed(2)}`;
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

// Compact form for the event table (the detail panel shows the full timestamp):
// "MM-DD HH:MM:SS".
export function fmtTsShort(ts: number | null): string {
  const d = tsToDate(ts);
  if (!d) return '—';
  return d.toISOString().slice(5, 19).replace('T', ' ');
}
