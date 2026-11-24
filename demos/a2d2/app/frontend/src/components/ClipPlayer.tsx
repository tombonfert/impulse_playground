import { useEffect, useRef, useState } from 'react';

// Event clip (MP4 exported by a2d2_analysis.ipynb) synced with the deep-dive playhead.
// The clip starts at the event start and plays in real time (frames downsampled to
// clip_fps and written at clip_fps), so  video_t = epoch_s - event_start_s.
//   seek prop (hover / click / timeline / keys)  -> video jumps there
//   playback, scrubber, ±step buttons            -> onTime(epoch_s) moves the playhead
// Custom controls (rather than native ones) so the time readout stays in event time.

interface Props {
  src: string;
  recordingStartS: number; // = event start (clip t = 0)
  recordingEndS: number; // = event end
  offsetS: number;
  rotateDeg: number;
  trimEndS: number; // 0 = none
  seek: { s: number; nonce: number } | null; // epoch seconds requested by the charts
  onTime: (epochS: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

export default function ClipPlayer({ src, recordingStartS, recordingEndS, offsetS, rotateDeg, trimEndS, seek, onTime, onPlayingChange }: Props) {
  const v = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [outside, setOutside] = useState(false);
  const pending = useRef<number | null>(null); // seek requested before metadata was loaded
  const programmatic = useRef(false); // suppress echoing our own seeks back to the charts
  const end = trimEndS > 0 && dur > 0 ? Math.min(trimEndS, dur) : dur;
  // Refs for values read from async callbacks (metadata load) — avoids stale closures.
  const endRef = useRef(0);
  endRef.current = end;

  const toEpoch = (vt: number) => recordingStartS + vt - offsetS;
  const toVideo = (epochS: number) => epochS - recordingStartS + offsetS;

  const applySeek = (epochS: number) => {
    const el = v.current;
    const e = endRef.current;
    if (!el || !e) {
      pending.current = epochS;
      return;
    }
    const want = toVideo(epochS);
    const vt = Math.max(0, Math.min(e, want));
    setOutside(Math.abs(vt - want) > 0.05);
    if (Math.abs(el.currentTime - vt) > 1e-3) {
      programmatic.current = true; // a real seek follows -> its 'seeked' must not echo back
      el.currentTime = vt;
    }
    setT(vt);
  };

  useEffect(() => {
    if (seek) applySeek(seek.s);
  }, [seek?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // User-driven video time change -> playhead.
  const emit = (vt: number) => {
    setT(vt);
    setOutside(false);
    onTime(toEpoch(vt));
  };

  // rAF loop while playing -> smooth playhead (timeupdate fires only ~4x/s).
  useEffect(() => {
    if (!playing) return undefined;
    let id = 0;
    const tick = () => {
      const el = v.current;
      if (el) {
        if (end && el.currentTime >= end) {
          el.pause();
          el.currentTime = end;
        }
        emit(el.currentTime);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, end]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const el = v.current;
    if (!el) return;
    if (el.paused) {
      if (end && el.currentTime >= end - 0.05) el.currentTime = 0;
      void el.play();
    } else el.pause();
  };
  const step = (ds: number) => {
    const el = v.current;
    if (!el) return;
    el.pause();
    const vt = Math.max(0, Math.min(end || el.duration, el.currentTime + ds));
    el.currentTime = vt;
    emit(vt);
  };

  const recT = t - offsetS;
  const recDur = recordingEndS - recordingStartS;
  // Part of the video timeline covered by the telemetry recording (highlighted on the scrubber).
  const covA = end ? Math.max(0, offsetS) / end : 0;
  const covB = end ? Math.min(end, offsetS + recDur) / end : 0;

  return (
    <div className="media-view">
      <div className="media-frame" onClick={toggle}>
        <video
          ref={v}
          src={src}
          preload="auto"
          playsInline
          muted
          style={{ transform: `rotate(${rotateDeg}deg)` }}
          onLoadedMetadata={(e) => {
            const el = e.target as HTMLVideoElement;
            setDur(el.duration);
            endRef.current = trimEndS > 0 ? Math.min(trimEndS, el.duration) : el.duration;
            if (pending.current != null) {
              const s = pending.current;
              pending.current = null;
              applySeek(s);
            }
          }}
          onPlay={() => { setPlaying(true); onPlayingChange?.(true); }}
          onPause={() => { setPlaying(false); onPlayingChange?.(false); }}
          onSeeked={(e) => {
            if (programmatic.current) { programmatic.current = false; return; }
            if (!playing) emit((e.target as HTMLVideoElement).currentTime);
          }}
        />
        {!playing && <div className="play-overlay">▶</div>}
        {outside && <div className="media-note">outside the clip — showing nearest frame</div>}
      </div>
      <div className="media-controls">
        <button className="small-btn" onClick={() => step(-0.1)} title="−0.1 s">◀︎</button>
        <button className="small-btn" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
        <button className="small-btn" onClick={() => step(0.1)} title="+0.1 s">▶︎</button>
        <div className="scrub">
          <div className="scrub-cov" style={{ left: `${covA * 100}%`, width: `${Math.max(0, covB - covA) * 100}%` }}
            title="event window" />
          <input
            type="range"
            min={0}
            max={end || 1}
            step={0.033}
            value={t}
            onChange={(e) => {
              const el = v.current;
              if (!el) return;
              const vt = Number(e.target.value);
              el.currentTime = vt;
              emit(vt);
            }}
          />
        </div>
        <select value={rate} onChange={(e) => { const r = Number(e.target.value); setRate(r); if (v.current) v.current.playbackRate = r; }}>
          {[0.1, 0.25, 0.5, 1].map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>
      </div>
      <div className="media-meta">
        clip {t.toFixed(2)} s / {end.toFixed(1)} s · event {recT >= 0 ? `+${recT.toFixed(2)}` : recT.toFixed(2)} s
        {recT > recDur ? ' (after event end)' : ''}
      </div>
    </div>
  );
}
