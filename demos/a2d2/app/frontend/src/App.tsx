import { useEffect, useMemo, useState } from 'react';
import {
  EventRow,
  Filters,
  RoutePoint,
  fetchEvents,
  fetchFilters,
  fetchRoute,
} from './api';
import FilterSidebar, { SelectedFilters } from './components/FilterSidebar';
import EventTable from './components/EventTable';
import MapView from './components/MapView';
import DetailPanel from './components/DetailPanel';
import LandingPage from './components/LandingPage';

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

  // Load filter options once.
  useEffect(() => {
    fetchFilters()
      .then((f) => {
        setFilters(f);
        setSelected((s) => ({ ...s, start_ts: f.min_ts, end_ts: f.max_ts }));
      })
      .catch((e) => setError(String(e)));
  }, []);

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
  }, [selected]);

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

  if (view === 'landing') {
    return (
      <LandingPage
        filters={filters}
        events={events}
        prefetching={prefetching}
        onStart={() => setView('explore')}
      />
    );
  }

  return (
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
  );
}
