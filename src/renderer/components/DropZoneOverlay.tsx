import { useState, useCallback, useRef } from 'react';
import type { DropZone } from '../../shared/layout-types';
import type { LayoutAction } from '../hooks/useLayoutState';

interface DropZoneOverlayProps {
  paneId: string;
  layoutDispatch: React.Dispatch<LayoutAction>;
}

const ZONES: DropZone[] = ['left', 'right', 'top', 'bottom'];

export function DropZoneOverlay({ paneId, layoutDispatch }: DropZoneOverlayProps) {
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const getZoneFromPosition = useCallback((clientX: number, clientY: number): DropZone => {
    const el = overlayRef.current;
    if (!el) return 'right';

    const rect = el.getBoundingClientRect();
    // Pick the closest edge (in absolute pixels, so aspect ratio doesn't skew it)
    const distances: [DropZone, number][] = [
      ['left', clientX - rect.left],
      ['right', rect.right - clientX],
      ['top', clientY - rect.top],
      ['bottom', rect.bottom - clientY],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = getZoneFromPosition(e.clientX, e.clientY);
    setActiveZone(zone);
  }, [getZoneFromPosition]);

  const handleDragLeave = useCallback(() => {
    setActiveZone(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!activeZone) return;

    const sourcePaneId = e.dataTransfer.getData('application/tether-pane');
    const sessionId = e.dataTransfer.getData('application/tether-session');

    if (sourcePaneId) {
      // Moving an existing pane
      if (sourcePaneId !== paneId) {
        layoutDispatch({ type: 'MOVE_PANE', sourcePaneId, targetPaneId: paneId, zone: activeZone });
      }
    } else if (sessionId) {
      // Dragging a new session from the sidebar
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
