import { useState, useCallback, useRef } from 'react';
import type { DropZone } from '../../shared/layout-types';
import type { LayoutAction } from '../hooks/useLayoutState';

interface DropZoneOverlayProps {
  paneId: string;
  layoutDispatch: React.Dispatch<LayoutAction>;
}

const ZONES: DropZone[] = ['left', 'right', 'top', 'bottom', 'center'];

export function DropZoneOverlay({ paneId, layoutDispatch }: DropZoneOverlayProps) {
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const getZoneFromPosition = useCallback((clientX: number, clientY: number): DropZone | null => {
    const el = overlayRef.current;
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;

    // Edges take priority over center
    if (x < 0.25) return 'left';
    if (x > 0.75) return 'right';
    if (y < 0.25) return 'top';
    if (y > 0.75) return 'bottom';
    return 'center';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const zone = getZoneFromPosition(e.clientX, e.clientY);
    setActiveZone(zone);
  }, [getZoneFromPosition]);

  const handleDragLeave = useCallback(() => {
    setActiveZone(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sessionId = e.dataTransfer.getData('application/tether-session');
    if (!sessionId || !activeZone) return;

    if (activeZone === 'center') {
      layoutDispatch({ type: 'REPLACE_SESSION', paneId, sessionId });
    } else {
      layoutDispatch({ type: 'ADD_PANE', targetPaneId: paneId, sessionId, zone: activeZone });
    }
    setActiveZone(null);
  }, [paneId, activeZone, layoutDispatch]);

  return (
    <div
      ref={overlayRef}
      className="drop-zone-overlay"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {ZONES.map(zone => (
        <div
          key={zone}
          className={`drop-zone-indicator drop-zone-indicator--${zone} ${
            activeZone === zone ? 'drop-zone-indicator--active' : ''
          }`}
        />
      ))}
    </div>
  );
}
