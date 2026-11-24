import { useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { Map as MapLibre } from 'react-map-gl/maplibre';
import { RoutePoint, fetchRoute } from '../api';

// Drive route (GPS channels) with the event segment highlighted and the car's position at
// the playhead. Click the route to seek to the nearest moment.

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// route points carry the channel timestamp (µs) -> epoch seconds
const tsS = (p: RoutePoint) => p[2] / 1e6;

function positionAt(route: RoutePoint[], s: number): [number, number] | null {
  if (!route.length) return null;
  if (s <= tsS(route[0])) return [route[0][1], route[0][0]];
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1];
    const b = route[i];
    if (tsS(b) >= s) {
      const f = (s - tsS(a)) / (tsS(b) - tsS(a) || 1);
      return [a[1] + f * (b[1] - a[1]), a[0] + f * (b[0] - a[0])];
    }
  }
  const last = route[route.length - 1];
  return [last[1], last[0]];
}

export default function MiniMap({ containerId, band, playheadS, onSeek }: {
  containerId: string;
  band: [number, number];
  playheadS: number | null;
  onSeek: (s: number) => void;
}) {
  const [route, setRoute] = useState<RoutePoint[]>([]);
  useEffect(() => { fetchRoute(containerId).then(setRoute).catch(() => setRoute([])); }, [containerId]);

  const seg = useMemo(() => route.filter((p) => tsS(p) >= band[0] - 2 && tsS(p) <= band[1] + 2), [route, band]);
  const [view, setView] = useState({ longitude: 11.42, latitude: 48.76, zoom: 15, pitch: 0, bearing: 0 });
  useEffect(() => {
    const c = positionAt(route, (band[0] + band[1]) / 2);
    if (c) setView((v) => ({ ...v, longitude: c[0], latitude: c[1], zoom: 16 }));
  }, [route, band[0], band[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = playheadS != null ? positionAt(route, playheadS) : null;
  if (route.length < 2) return null;

  const layers = [
    new PathLayer<{ path: [number, number][] }>({ id: 'route', data: [{ path: route.map((p) => [p[1], p[0]] as [number, number]) }], getPath: (d) => d.path,
      getColor: [74, 158, 255, 160], getWidth: 4, widthUnits: 'pixels' }),
    new PathLayer<{ path: [number, number][] }>({ id: 'event', data: [{ path: seg.map((p) => [p[1], p[0]] as [number, number]) }], getPath: (d) => d.path,
      getColor: [255, 92, 92, 255], getWidth: 6, widthUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'pts', data: route, pickable: true, getPosition: (p: RoutePoint) => [p[1], p[0]],
      getRadius: 6, radiusUnits: 'pixels', getFillColor: [0, 0, 0, 0],
      onClick: ({ object }) => object && onSeek(tsS(object as RoutePoint)) }),
    pos ? new ScatterplotLayer({ id: 'pos', data: [pos], getPosition: (p: [number, number]) => p, getRadius: 8,
      radiusUnits: 'pixels', getFillColor: [255, 213, 74, 255], getLineColor: [16, 21, 27, 255], stroked: true,
      lineWidthMinPixels: 2, updateTriggers: { getPosition: [playheadS] } }) : null,
  ];
  return (
    <div className="minimap">
      <div className="ts-title">Position on the drive (red = event)</div>
      <div className="minimap-map">
        <DeckGL viewState={view} onViewStateChange={(e) => setView(e.viewState as typeof view)} controller layers={layers}>
          <MapLibre mapStyle={MAP_STYLE} />
        </DeckGL>
      </div>
    </div>
  );
}
