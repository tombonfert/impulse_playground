import { useEffect, useMemo, useState } from 'react';
import {
  EventRow,
  Filters,
  RoutePoint,
  fetchConfig,
  fetchEvents,
  fetchFilters,
  fetchRoute,
} from './api';
import FilterSidebar, { SelectedFilters } from './components/FilterSidebar';
import EventTable from './components/EventTable';
import MapView from './components/MapView';
import DetailPanel from './components/DetailPanel';
import LandingPage from './components/LandingPage';
import WarehouseConfig from './components/WarehouseConfig';

const EMPTY: SelectedFilters = {
  vehicle: [],
  city: [],
  event_name: [],
  event_type: [],
  start_ts: null,
  end_ts: null,
  verified_only: false,
};

export default function App() {
  const [view, setView] = useState<'landing' | 'explore'>('landing');
  const [filters, setFilters] = useState<Filters | null>(null);
  const [selected, setSelected] = useState<SelectedFilters>(EMPTY);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [firstEventsLoaded, setFirstEventsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  // Bumped after a warehouse change to force filters + events to refetch.
  const [reloadKey, setReloadKey] = useState(0);

  // Load the current warehouse id for the config overlay.
  useEffect(() => {
    fetchConfig()
      .then((c) => setWarehouseId(c.warehouse_id))
      .catch(() => undefined);
  }, []);

  // Load filter options once.
  useEffect(() => {
    fetchFilters()
      .then((f) => {
        setFilters(f);
        setSelected((s) => ({ ...s, start_ts: f.min_ts, end_ts: f.max_ts }));
      })
      .catch((e) => setError(String(e)));
  }, [reloadKey]);

  // Refetch events whenever filters change.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchEvents(selected)
      .then((rows) => {
        setEvents(rows);
        // Keep selection if still present, else clear.
        setSelectedEvent((prev) =>
          prev &&
          rows.find(
            (r) =>
              r.container_id === prev.container_id &&
              r.event_instance_id === prev.event_instance_id,
          )
            ? prev
            : null,
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        setLoading(false);
        setFirstEventsLoaded(true);
      });
  }, [selected, reloadKey]);

  // Load route for the selected event's drive.
  useEffect(() => {
    if (!selectedEvent) {
      setRoute([]);
      return;
    }
    fetchRoute(selectedEvent.container_id)
      .then(setRoute)
      .catch(() => setRoute([]));
  }, [selectedEvent?.container_id]);

  const eventCount = events.length;
  const clipCount = useMemo(() => events.filter((e) => e.has_clip).length, [events]);

  // Warm-up indicator: the standard first queries (filters + events) keep firing
  // on mount regardless of view, warming the SQL warehouse while the landing page
  // is shown. `prefetching` stays true until both have resolved.
  const prefetching = !filters || !firstEventsLoaded;

  const onWarehouseSaved = (cfg: { warehouse_id: string }) => {
    setWarehouseId(cfg.warehouse_id);
    setShowConfig(false);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  const configOverlay = showConfig && (
    <WarehouseConfig
      warehouseId={warehouseId}
      onSaved={onWarehouseSaved}
      onClose={() => setShowConfig(false)}
    />
  );

  if (view === 'landing') {
    return (
      <>
        <LandingPage
          filters={filters}
          events={events}
          prefetching={prefetching}
          onStart={() => setView('explore')}
          onOpenConfig={() => setShowConfig(true)}
        />
        {configOverlay}
      </>
    );
  }

  return (
    <>
    <div className="app">
      <header className="topbar">
        <button
          className="back-btn"
          onClick={() => setView('landing')}
          title="Back to the overview"
        >
          ← Overview
        </button>
        <span className="brand">Impulse Event Explorer</span>
        <span className="sub">
          {loading ? 'loading…' : `${eventCount} events · ${clipCount} with clips`}
        </span>
        {error && <span className="err">{error}</span>}
        <button
          className="gear-btn"
          onClick={() => setShowConfig(true)}
          title="Configure SQL warehouse"
          aria-label="Configure SQL warehouse"
        >
          ⚙
        </button>
      </header>
      <div className="body">
        <FilterSidebar filters={filters} selected={selected} onChange={setSelected} />
        <main className="main">
          <MapView
            events={events}
            route={route}
            selected={selectedEvent}
            onSelect={setSelectedEvent}
          />
          <div className="lower">
            <EventTable
              events={events}
              selected={selectedEvent}
              onSelect={setSelectedEvent}
            />
            <DetailPanel event={selectedEvent} />
          </div>
        </main>
      </div>
    </div>
    {configOverlay}
    </>
  );
}
