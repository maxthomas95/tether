import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

interface TerminalPanelProps {
  sessionId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onResize: () => void;
}

export function TerminalPanel({ sessionId, containerRef, onResize }: TerminalPanelProps) {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    observerRef.current = new ResizeObserver(() => {
      requestAnimationFrame(onResize);
    });
    observerRef.current.observe(el);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [containerRef, onResize]);

  if (!sessionId) {
    return (
      <div className="terminal-container">
        <div className="terminal-placeholder">
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
      className="terminal-container"
      style={{ padding: 4 }}
    />
  );
}
