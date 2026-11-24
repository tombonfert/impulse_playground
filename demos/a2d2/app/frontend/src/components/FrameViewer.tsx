import { useEffect, useRef, useState } from 'react';
import { frameUrl } from '../api';

// Front-camera frame nearest to the playhead (from {prefix}_camera_frames) — used when the
// event has no MP4 clip, so every event still has visuals. Requests are debounced (the
// playhead moves on every hover frame) and the previous image stays visible until the
// next one has loaded, so scrubbing doesn't flicker.

const DEBOUNCE_MS = 120;

export default function FrameViewer({ containerId, playheadS, originS }: {
  containerId: string;
  playheadS: number | null;
  originS: number;
}) {
  const [shown, setShown] = useState<{ url: string; t: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const want = useRef<number | null>(null);

  useEffect(() => {
    if (playheadS == null) return undefined;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // Quantize to 0.1 s so repeated hovers hit the browser cache.
      const t = Math.round(playheadS * 10) / 10;
      want.current = t;
      const url = frameUrl(containerId, t);
      setLoading(true);
      const img = new Image();
      img.onload = () => {
        if (want.current !== t) return;
        setShown({ url, t });
        setMissing(false);
        setLoading(false);
      };
      img.onerror = () => {
        if (want.current !== t) return;
        setMissing(true);
        setLoading(false);
      };
      img.src = url;
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer.current);
  }, [playheadS, containerId]);

  return (
    <div className="media-view">
      <div className="media-frame frame-viewer">
        {shown ? <img src={shown.url} alt="front camera" /> : <div className="frame-empty">Loading camera frame…</div>}
        {loading && <div className="media-note">loading…</div>}
        {missing && <div className="media-note">no camera frame near this time</div>}
      </div>
      <div className="media-meta">
        camera frame {shown ? `@ ${shown.t - originS >= 0 ? '+' : ''}${(shown.t - originS).toFixed(1)} s` : ''} · no MP4 clip for this
        event — the nearest frame follows the playhead
      </div>
    </div>
  );
}
