import { useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { Map as MapLibre } from 'react-map-gl/maplibre';
import { EventRow, RoutePoint, colorForType } from '../api';

// Free, token-less basemap (Carto positron via MapLibre GL style).
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

interface Props {
  events: EventRow[];
  route: RoutePoint[];
  selected: EventRow | null;
  onSelect: (e: EventRow) => void;
}

interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

const DEFAULT_VIEW: ViewState = {
  longitude: 11.42,
  latitude: 48.76,
  zoom: 9,
  pitch: 0,
  bearing: 0,
};

export default function MapView({ events, route, selected, onSelect }: Props) {
  const [viewState, setViewState] = useState<ViewState>(DEFAULT_VIEW);

  const located = useMemo(
    () => events.filter((e) => e.lat != null && e.lon != null),
    [events],
  );

  // Fit view to the located events whenever the set changes.
  useEffect(() => {
    if (located.length === 0) return;
    const lats = located.map((e) => e.lat as number);
    const lons = located.map((e) => e.lon as number);
    const latC = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lonC = (Math.min(...lons) + Math.max(...lons)) / 2;
    const span = Math.max(
      Math.max(...lats) - Math.min(...lats),
      Math.max(...lons) - Math.min(...lons),
      0.01,
    );
    const zoom = Math.min(Math.max(11 - Math.log2(span * 50), 4), 14);
    setViewState((v) => ({ ...v, latitude: latC, longitude: lonC, zoom }));
  }, [located]);

  const layers = [
    route.length > 1
      ? new PathLayer<{ path: [number, number][] }>({
        id: 'route',
        data: [{ path: route.map((p) => [p[1], p[0]] as [number, number]) }],
        getPath: (d) => d.path,
        getColor: [30, 100, 200, 180],
        getWidth: 4,
        widthMinPixels: 2,
        widthUnits: 'pixels',
      })
      : null,
    new ScatterplotLayer<EventRow>({
      id: 'events',
      data: located,
      pickable: true,
      getPosition: (e) => [e.lon as number, e.lat as number],
      getFillColor: (e) => {
        const [r, g, b] = colorForType(e.event_type);
        return [r, g, b, 220];
      },
      getLineColor: (e) =>
        selected &&
        selected.container_id === e.container_id &&
        selected.event_instance_id === e.event_instance_id
          ? [20, 20, 20, 255]
          : [255, 255, 255, 200],
      getRadius: (e) =>
        selected &&
        selected.container_id === e.container_id &&
        selected.event_instance_id === e.event_instance_id
          ? 140
          : 80,
      radiusMinPixels: 5,
      radiusMaxPixels: 22,
      lineWidthMinPixels: 2,
      stroked: true,
      onClick: ({ object }) => object && onSelect(object as EventRow),
      updateTriggers: { getLineColor: [selected], getRadius: [selected] },
    }),
  ];

  return (
    <div className="map-wrap">
      <DeckGL
        viewState={viewState}
        onViewStateChange={(e) => setViewState(e.viewState as ViewState)}
        controller={true}
        layers={layers}
        getTooltip={({ object }) =>
          object &&
          (object as EventRow).event_name && {
            text: `${(object as EventRow).event_name}\n${(object as EventRow).event_type}\n${
              (object as EventRow).city ?? ''
            }`,
          }
        }
      >
        <MapLibre mapStyle={MAP_STYLE} />
      </DeckGL>
      <Legend events={located} />
    </div>
  );
}

function Legend({ events }: { events: EventRow[] }) {
  const types = Array.from(new Set(events.map((e) => e.event_type))).sort();
  if (types.length === 0) return null;
  return (
    <div className="legend">
      {types.map((t) => {
        const [r, g, b] = colorForType(t);
        return (
          <div key={t} className="legend-row">
            <span className="dot" style={{ background: `rgb(${r},${g},${b})` }} />
            {t}
          </div>
        );
      })}
    </div>
  );
}
