import { useState } from 'react';
import { Filters, EventRow } from '../api';
import databricksIcon from '../assets/databricks_icon.svg';
import impulseIcon from '../assets/impulse_icon.svg';

interface Props {
  filters: Filters | null;
  events: EventRow[];
  prefetching: boolean;
  onStart: () => void;
  onOpenConfig: () => void;
}

type Kpi = { value: string; label: string; expands?: boolean };
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
      'Front-camera images and the vehicle-bus signals from 3 real city drives are loaded into Impulse — images as frames, every bus signal as its own time-series channel.',
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
    desc: 'Rule-based event detection + GenAI verification',
    detail:
      'Two stages. First, tail-calibrated rules over the bus + perception channels flag candidate ' +
      'safety events (hard braking, pedestrian-in-path, close following, evasive maneuvers) and ' +
      'compute within-event statistics. Then a multimodal LLM reviews each event’s camera frames ' +
      'and telemetry and judges whether it is genuinely the event of interest or a false positive — ' +
      'attaching a confidence and a one-line reason. The rules give high recall; the LLM gives ' +
      'precision and an auditable explanation.',
    kpis: [
      { value: '7', label: 'event types', expands: true },
      { value: '85 → 38', label: 'candidates → verified' },
      { value: '47', label: 'false positives caught' },
      { value: 'Claude Opus 4.8', label: 'vision-model judge' },
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

// The 7 mined event types, revealed when the "event types" KPI is clicked.
const EVENT_TYPES: { name: string; desc: string }[] = [
  {
    name: 'Emergency braking',
    desc: 'Hard deceleration while driving — excludes simply holding the brake at a standstill.',
  },
  {
    name: 'Imminent rear-end',
    desc: 'Following the in-path lead vehicle too closely — dangerously short time-headway.',
  },
  {
    name: 'Pedestrian in path',
    desc: 'A pedestrian directly ahead in the ego lane, at close range.',
  },
  {
    name: 'Pedestrian near-miss',
    desc: 'A pedestrian passes close to the car while it is moving at speed.',
  },
  {
    name: 'Cyclist close encounter',
    desc: 'A cyclist passes within a few metres — typically a close side pass.',
  },
  {
    name: 'Sharp cornering',
    desc: 'Aggressive steering at speed — a tight, fast turn.',
  },
  {
    name: 'Evasive maneuver',
    desc: 'A sudden steer-and-brake combination, typical of dodging an obstacle.',
  },
];

// Key takeaways shown below the step cards: why this demo is powerful, split into the
// Databricks-native platform capabilities and Impulse's analytics role.
const HEADLINE =
  'One governed platform turns raw sensor data into explainable, safety-relevant insight — ' +
  'rules for recall, GenAI for precision, a human in the loop.';

const TAKEAWAYS: { icon: string; title: string; bullets: { lead: string; text: string }[] }[] = [
  {
    icon: databricksIcon,
    title: 'Powered by Databricks',
    bullets: [
      {
        lead: 'Lakehouse, end-to-end',
        text: 'all data + AI verdicts in one Unity-Catalog catalog — no movement, full lineage.',
      },
      {
        lead: 'GenAI built in',
        text: 'multimodal Foundation Models verify events in-platform.',
      },
      {
        lead: 'Scales with Spark + serverless',
        text: 'parallel ingest, distributed inference, serverless verification.',
      },
      {
        lead: 'Ships as a product',
        text: 'Databricks App + SQL warehouse, deployed via Asset Bundles.',
      },
    ],
  },
  {
    icon: impulseIcon,
    title: 'Driven by Impulse',
    bullets: [
      {
        lead: 'Declarative event mining',
        text: 'safety events as signal logic (TSAL), not bespoke pipelines.',
      },
      {
        lead: 'Built for measurement data',
        text: 'containers-of-channels model; multi-drive / fleet-native.',
      },
      {
        lead: 'Governed gold layer',
        text: 'events + stats as fact/dimension tables this app queries.',
      },
      {
        lead: 'The analytics brain',
        text: 'turns raw channels into queryable events & stats.',
      },
    ],
  },
];

export default function LandingPage({ onStart, onOpenConfig }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  // Latches once the user opens any card, so the attention pulse stops for good.
  const [hasInteracted, setHasInteracted] = useState(false);
  const [activeTakeaway, setActiveTakeaway] = useState<string | null>(null);
  const activeStep = STEPS.find((s) => s.key === active) ?? null;
  const activeTake = TAKEAWAYS.find((t) => t.title === activeTakeaway) ?? null;
  const toggleTakeaway = (title: string) =>
    setActiveTakeaway((cur) => (cur === title ? null : title));

  const toggle = (key: string) => {
    setHasInteracted(true);
    setActive((cur) => (cur === key ? null : key));
    setShowEvents(false);
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-cta">
          <button
            className="gear-btn"
            onClick={onOpenConfig}
            title="Configure SQL warehouse"
            aria-label="Configure SQL warehouse"
          >
            ⚙
          </button>
          <button className="start-btn" onClick={onStart}>
            Let&apos;s Start
          </button>
        </div>

        <h1 className="landing-title">Impulse Event Explorer</h1>

        <p className="landing-lead">
          This demo turns <strong>3 real city drives</strong> of Audi&apos;s{' '}
          <strong>A2D2</strong> open autonomous-driving dataset into explorable,
          safety-relevant driving events.
        </p>

        <ul className="landing-steps">
          {STEPS.map((s) => {
            const isActive = active === s.key;
            const pulse = !hasInteracted && s.key === 'ingest';
            return (
              <li
                key={s.key}
                className={`step-card${isActive ? ' step-card--active' : ''}${
                  pulse ? ' step-card--pulse' : ''
                }`}
                role="button"
                tabIndex={0}
                aria-expanded={isActive}
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
                <span
                  className={`step-expand${isActive ? ' step-expand--open' : ''}`}
                  aria-hidden="true"
                >
                  ⌄
                </span>
              </li>
            );
          })}
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
              {activeStep.kpis.map((k) =>
                k.expands ? (
                  <button
                    key={k.label}
                    className={`step-kpi step-kpi--btn${showEvents ? ' step-kpi--open' : ''}`}
                    onClick={() => setShowEvents((v) => !v)}
                    aria-expanded={showEvents}
                  >
                    <span className="step-kpi-value">{k.value}</span>
                    <span className="step-kpi-label">
                      {k.label} {showEvents ? '▴' : '▾'}
                    </span>
                  </button>
                ) : (
                  <div className="step-kpi" key={k.label}>
                    <span className="step-kpi-value">{k.value}</span>
                    <span className="step-kpi-label">{k.label}</span>
                  </div>
                ),
              )}
            </div>
            {activeStep.key === 'mine' && showEvents && (
              <div className="event-types">
                {EVENT_TYPES.map((ev) => (
                  <div className="event-card" key={ev.name}>
                    <span className="event-name">{ev.name}</span>
                    <span className="event-desc">{ev.desc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <section className="takeaways-wrap">
          <p className="takeaways-headline">{HEADLINE}</p>
          <ul className="takeaway-cards">
            {TAKEAWAYS.map((g) => {
              const isActive = activeTakeaway === g.title;
              return (
                <li
                  key={g.title}
                  className={`takeaway-card${isActive ? ' takeaway-card--active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isActive}
                  onClick={() => toggleTakeaway(g.title)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleTakeaway(g.title);
                    }
                  }}
                >
                  <img className="takeaway-icon-img" src={g.icon} alt="" aria-hidden="true" />
                  <span className="takeaway-title">{g.title}</span>
                  <span
                    className={`step-expand${isActive ? ' step-expand--open' : ''}`}
                    aria-hidden="true"
                  >
                    ⌄
                  </span>
                </li>
              );
            })}
          </ul>

          {activeTake && (
            <div className="takeaway-detail" key={activeTake.title}>
              <div className="takeaway-features">
                {activeTake.bullets.map((b) => (
                  <div className="takeaway-feature" key={b.lead}>
                    <span className="feature-lead">{b.lead}</span>
                    <span className="feature-text">{b.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

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
          <span className="footer-sep" aria-hidden="true">
            ·
          </span>
          <span className="landing-source">
            Built with{' '}
            <a
              className="landing-link-muted"
              href="https://github.com/databrickslabs/impulse"
              target="_blank"
              rel="noopener noreferrer"
            >
              Impulse
            </a>{' '}
            (open source)
          </span>
        </p>
      </div>
    </div>
  );
}
