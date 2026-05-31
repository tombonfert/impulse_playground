import { useState } from 'react';
import { Filters, EventRow } from '../api';

interface Props {
  filters: Filters | null;
  events: EventRow[];
  prefetching: boolean;
  onStart: () => void;
}

type Kpi = { value: string; label: string };
type Step = {
  key: string;
  icon: string;
  verb: string;
  desc: string;
  detail: string;
  kpis: Kpi[];
};

// The four pipeline steps. Each card is clickable and reveals a detail panel
// (concise description + KPI chips) below the row.
const STEPS: Step[] = [
  {
    key: 'ingest',
    icon: '📥',
    verb: 'Ingest',
    desc: 'Bus signals + front-camera images into the Impulse time-series framework',
    detail:
      'Front-camera images and the vehicle-bus signals from 3 real city drives are loaded into Impulse — images as frames, every bus signal as its own time-series channel, all aligned on a common timeline.',
    kpis: [
      { value: '~231 GB', label: 'raw input' },
      { value: '65,371', label: 'camera frames' },
      { value: '22', label: 'bus signals → channels' },
      { value: '3', label: 'city drives' },
    ],
  },
  {
    key: 'detect',
    icon: '🎯',
    verb: 'Detect',
    desc: 'Objects and their distance, per frame — detection + monocular depth',
    detail:
      'Each sampled frame runs through an object detector and a monocular metric-depth model, producing per-frame object-count and distance-to-object channels — both overall and for the center-ahead (in-path) region.',
    kpis: [
      { value: '8', label: 'object classes' },
      { value: 'SSDlite', label: '+ Depth Anything V2' },
      { value: '24', label: 'detection channels' },
      { value: '1 fps', label: 'frame sampling' },
    ],
  },
  {
    key: 'mine',
    icon: '⚠️',
    verb: 'Mine',
    desc: 'Safety events: hard braking, pedestrian-in-path, close following, evasive maneuvers',
    detail:
      'Tail-calibrated rules over the bus + perception channels surface safety-relevant events, compute within-event statistics for each one, and export a short video clip per event.',
    kpis: [
      { value: '7', label: 'event types' },
      { value: '85', label: 'events found' },
      { value: '63', label: 'video clips' },
      { value: '≤10 s', label: 'clip length' },
    ],
  },
  {
    key: 'explore',
    icon: '🗺️',
    verb: 'Explore',
    desc: 'Each event on a GPS map — watch its clip, inspect per-event statistics',
    detail:
      'This app: browse every event on a GPS map with the full drive route, watch its clip, and inspect the per-event statistics — filterable by city, event type, and time window.',
    kpis: [
      { value: 'Map', label: '+ drive route' },
      { value: 'Clips', label: 'per event' },
      { value: 'Stats', label: 'per event' },
      { value: 'Filters', label: 'city · event · time' },
    ],
  },
];

export default function LandingPage({ onStart }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const activeStep = STEPS.find((s) => s.key === active) ?? null;

  const toggle = (key: string) => setActive((cur) => (cur === key ? null : key));

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-cta">
          <button className="start-btn" onClick={onStart}>
            Let&apos;s Start
          </button>
        </div>

        <h1 className="landing-title">A2D2 Event Explorer</h1>

        <p className="landing-lead">
          <strong>A2D2</strong> is Audi&apos;s open autonomous-driving dataset. This demo
          turns <strong>3 real city drives</strong> into explorable, safety-relevant driving
          events.
        </p>

        <ul className="landing-steps">
          {STEPS.map((s) => (
            <li
              key={s.key}
              className={`step-card${active === s.key ? ' step-card--active' : ''}`}
              role="button"
              tabIndex={0}
              aria-expanded={active === s.key}
              onClick={() => toggle(s.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(s.key);
                }
              }}
            >
              <span className="step-icon" aria-hidden="true">
                {s.icon}
              </span>
              <div className="step-body">
                <span className="step-verb">{s.verb}</span>
                <span className="step-desc">{s.desc}</span>
              </div>
            </li>
          ))}
        </ul>

        {activeStep && (
          <div className="step-detail" key={activeStep.key}>
            <div className="step-detail-head">
              <span className="step-icon" aria-hidden="true">
                {activeStep.icon}
              </span>
              <span className="step-detail-title">{activeStep.verb}</span>
            </div>
            <p className="step-detail-text">{activeStep.detail}</p>
            <div className="step-kpis">
              {activeStep.kpis.map((k) => (
                <div className="step-kpi" key={k.label}>
                  <span className="step-kpi-value">{k.value}</span>
                  <span className="step-kpi-label">{k.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="landing-footer">
          {!activeStep && (
            <>
              <span className="step-hint">Click a step to see the details.</span>
              <span className="footer-sep" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span className="landing-source">
            Data source:{' '}
            <a
              className="landing-link-muted"
              href="https://www.a2d2.audi/en/"
              target="_blank"
              rel="noopener noreferrer"
            >
              the A2D2 dataset by Audi
            </a>
            .
          </span>
        </p>
      </div>
    </div>
  );
}
