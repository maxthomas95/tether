import { useState, type CSSProperties } from 'react';
import logo from '../assets/tether-ascii.json';

// Repeat the first pose at the end so the stepped strip loops seamlessly.
const strip = [...logo.frames, logo.frames[0]].join('\n');
const dimensions = {
  '--ascii-columns': logo.columns,
  '--ascii-rows': logo.rows,
  '--ascii-frames': logo.frames.length,
} as CSSProperties;

/** Baked text frames: no canvas, animation timers, or per-frame React updates. */
export function AsciiTether() {
  const [paused, setPaused] = useState(false);
  const label = paused ? 'Play logo animation' : 'Pause logo animation';

  return (
    <div className="ascii-tether" style={dimensions} data-paused={paused}>
      <div className="ascii-tether__viewport" aria-hidden="true">
        <pre className="ascii-tether__strip">{strip}</pre>
      </div>
      <button
        type="button"
        className="ascii-tether__toggle"
        aria-label={label}
        title={label}
        onClick={() => setPaused(value => !value)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false">
          {paused ? <path d="M3 1.5 10 6l-7 4.5z" /> : <path d="M3 2h2v8H3zM7 2h2v8H7z" />}
        </svg>
      </button>
    </div>
  );
}
