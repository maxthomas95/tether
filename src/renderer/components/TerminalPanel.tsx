import { useEffect, useRef, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import logoSrc from '../assets/logo.png';

interface TerminalPanelProps {
  sessionId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onResize: () => void;
}

export function TerminalPanel({ sessionId, containerRef, onResize }: TerminalPanelProps) {
  const observerRef = useRef<ResizeObserver | null>(null);

  const doResize = useCallback(() => {
    requestAnimationFrame(onResize);
  }, [onResize]);

  // ResizeObserver on the container element
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sessionId) return;

    observerRef.current = new ResizeObserver(doResize);
    observerRef.current.observe(el);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [containerRef, sessionId, doResize]);

  // Window resize fallback
  useEffect(() => {
    if (!sessionId) return;
    window.addEventListener('resize', doResize);
    return () => window.removeEventListener('resize', doResize);
  }, [sessionId, doResize]);

  // ALL hooks above, early return below
  if (!sessionId) {
    return (
      <div className="terminal-container">
        <div className="terminal-placeholder">
          <img src={logoSrc} alt="Tether" className="welcome-logo" />
          <p>Welcome to Tether</p>
          <p className="terminal-placeholder-sub">
            Create a new session to start working with Claude Code
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="terminal-container terminal-container--active"
    />
  );
}
