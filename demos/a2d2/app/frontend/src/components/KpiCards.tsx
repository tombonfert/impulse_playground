import { KpiDef, TSSeries } from '../api';

// Event-specific headline figures, computed over the event window from exactly the series
// the charts show. Each card knows the moment its value refers to (e.g. the instant of
// peak deceleration) — clicking it moves the playhead (and the video) there.

export interface KpiValue {
  def: KpiDef;
  value: number | null;
  atS: number | null; // epoch seconds of the moment the value refers to
}

function windowPoints(s: TSSeries | undefined, a: number, b: number): [number, number][] {
  if (!s) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < s.t.length; i += 1) {
    const v = s.v[i];
    if (v != null && s.t[i] >= a && s.t[i] <= b) out.push([s.t[i], v]);
  }
  return out;
}

function valueAt(s: TSSeries | undefined, t: number): number | null {
  if (!s || !s.t.length) return null;
  let best: number | null = null;
  for (let i = 0; i < s.t.length && s.t[i] <= t + 1e-6; i += 1) if (s.v[i] != null) best = s.v[i];
  return best;
}

function extremum(pts: [number, number][], kind: 'min' | 'max' | 'max_abs'): [number, number] | null {
  if (!pts.length) return null;
  return pts.reduce((best, p) => {
    if (kind === 'min') return p[1] < best[1] ? p : best;
    if (kind === 'max') return p[1] > best[1] ? p : best;
    return Math.abs(p[1]) > Math.abs(best[1]) ? p : best;
  });
}

export function computeKpis(defs: KpiDef[], series: Map<string, TSSeries>, a: number, b: number): KpiValue[] {
  return defs.map((def) => {
    const pts = windowPoints(series.get(def.channel), a, b);
    // split on the FIRST colon only: the reference may itself contain one (derived:thw_s)
    const sep = def.agg.indexOf(':');
    const agg = sep < 0 ? def.agg : def.agg.slice(0, sep);
    const ref = sep < 0 ? '' : def.agg.slice(sep + 1);
    if (agg === 'at_min_of' || agg === 'at_max_of') {
      const e = extremum(windowPoints(series.get(ref), a, b), agg === 'at_min_of' ? 'min' : 'max');
      return { def, value: e ? valueAt(series.get(def.channel), e[0]) : null, atS: e ? e[0] : null };
    }
    if (!pts.length) return { def, value: null, atS: null };
    switch (agg) {
      case 'min':
      case 'max':
      case 'max_abs': {
        const e = extremum(pts, agg)!;
        return { def, value: agg === 'max_abs' ? Math.abs(e[1]) : e[1], atS: e[0] };
      }
      case 'first':
        return { def, value: pts[0][1], atS: pts[0][0] };
      case 'last':
        return { def, value: pts[pts.length - 1][1], atS: pts[pts.length - 1][0] };
      case 'delta':
        return { def, value: pts[pts.length - 1][1] - pts[0][1], atS: pts[pts.length - 1][0] };
      case 'range':
        return { def, value: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])), atS: null };
      case 'mean':
      default:
        return { def, value: pts.reduce((s, p) => s + p[1], 0) / pts.length, atS: null };
    }
  });
}

export default function KpiCards({ kpis, originS, onSeek }: {
  kpis: KpiValue[];
  originS: number;
  onSeek: (s: number) => void;
}) {
  if (!kpis.length) return null;
  return (
    <div className="kpis">
      {kpis.map((k) => (
        <button
          key={k.def.label}
          className={`kpi${k.atS != null ? ' kpi-seek' : ''}`}
          title={`${k.def.help}${k.atS != null ? ' — click to jump to this moment' : ''}`}
          onClick={() => k.atS != null && onSeek(k.atS)}
        >
          <b>
            {k.value == null ? '—' : `${k.def.agg === 'delta' && k.value > 0 ? '+' : ''}${k.value.toFixed(k.def.digits)}`}
            {k.value != null && k.def.unit && <small> {k.def.unit}</small>}
          </b>
          <span>{k.def.label}</span>
          {k.atS != null && <em>@ {k.atS - originS >= 0 ? '+' : ''}{(k.atS - originS).toFixed(1)} s</em>}
        </button>
      ))}
    </div>
  );
}
