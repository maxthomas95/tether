import { useState, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { DropZone } from '../../shared/layout-types';
import type { LayoutAction } from '../hooks/useLayoutState';

interface DropZoneOverlayProps {
  paneId: string;
  layoutDispatch: React.Dispatch<LayoutAction>;
  currentLeafCount: number;
  maxPanes: number;
  isTargetPlaceholder?: boolean;
  isPaneDrag?: boolean;
}

const QUADRANT_ZONES: DropZone[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export function DropZoneOverlay({
  paneId,
  layoutDispatch,
  currentLeafCount,
  maxPanes,
  isTargetPlaceholder = false,
  isPaneDrag = false,
}: DropZoneOverlayProps) {
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const isBlocked = currentLeafCount >= maxPanes && !isTargetPlaceholder && !isPaneDrag;

  const getZoneFromPosition = useCallback((clientX: number, clientY: number): DropZone => {
    if (isTargetPlaceholder) return 'center';

    const el = overlayRef.current;
    if (!el) return 'right';

    const rect = el.getBoundingClientRect();
    if (currentLeafCount === 2 && maxPanes >= 4) {
      const x = clientX < rect.left + rect.width / 2 ? 'left' : 'right';
      const y = clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
      return `${y}-${x}` as DropZone;
    }

    // Pick the closest edge in absolute pixels so aspect ratio does not skew it.
    const distances: [DropZone, number][] = [
      ['left', clientX - rect.left],
      ['right', rect.right - clientX],
      ['top', clientY - rect.top],
      ['bottom', rect.bottom - clientY],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }, [currentLeafCount, isTargetPlaceholder, maxPanes]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    if (isBlocked) {
      e.dataTransfer.dropEffect = 'none';
      setActiveZone(null);
      return;
    }

    e.dataTransfer.dropEffect = 'move';
    const zone = getZoneFromPosition(e.clientX, e.clientY);
    setActiveZone(zone);
  }, [getZoneFromPosition, isBlocked]);

  const handleDragLeave = useCallback(() => {
    setActiveZone(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isBlocked) return;

    const sourcePaneId = e.dataTransfer.getData('application/tether-pane');
    const sessionId = e.dataTransfer.getData('application/tether-session');
    const zone = activeZone ?? (isTargetPlaceholder ? 'center' : 'right');

    if (sourcePaneId) {
      if (sourcePaneId !== paneId) {
        layoutDispatch({ type: 'MOVE_PANE', sourcePaneId, targetPaneId: paneId, zone });
      }
    } else if (sessionId) {
      if (isTargetPlaceholder) {
        layoutDispatch({ type: 'REPLACE_SESSION', paneId, sessionId });
        layoutDispatch({ type: 'SET_FOCUS', paneId });
      } else {
        layoutDispatch({ type: 'ADD_PANE', targetPaneId: paneId, sessionId, zone });
      }
    }
    setActiveZone(null);
  }, [activeZone, isBlocked, isTargetPlaceholder, layoutDispatch, paneId]);

  return (
    <div
      ref={overlayRef}
      className="drop-zone-overlay"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isBlocked ? (
        <div className="drop-preview-blocked">Maximum panes reached</div>
      ) : activeZone ? (
        <div
          className="drop-preview-highlight"
          style={getHighlightStyle(activeZone)}
        />
      ) : null}
    </div>
  );
}

function getHighlightStyle(zone: DropZone): CSSProperties {
  if (zone === 'center') {
    return { inset: 0 };
  }

  if (QUADRANT_ZONES.includes(zone)) {
    const top = zone.startsWith('top') ? 0 : '50%';
    const left = zone.endsWith('left') ? 0 : '50%';
    return { top, left, width: '50%', height: '50%' };
  }

  switch (zone) {
    case 'left':
      return { top: 0, left: 0, width: '50%', height: '100%' };
    case 'right':
      return { top: 0, right: 0, width: '50%', height: '100%' };
    case 'top':
      return { top: 0, left: 0, width: '100%', height: '50%' };
    case 'bottom':
      return { bottom: 0, left: 0, width: '100%', height: '50%' };
    default:
      return { inset: 0 };
  }
}
