import { useState, useCallback, useRef } from 'react';
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

type CellState = 'existing' | 'target' | 'placeholder';

interface PreviewCell {
  key: string;
  state: CellState;
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
    if (isTargetPlaceholder && currentLeafCount >= maxPanes) return 'center';

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

  const preview = getPreview(activeZone, currentLeafCount, maxPanes, isTargetPlaceholder);

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
      ) : (
        <div className={`drop-preview-grid ${preview.modifier}`}>
          {preview.cells.map(cell => (
            <div
              key={cell.key}
              className={`drop-preview-cell drop-preview-cell--${cell.state}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getPreview(
  activeZone: DropZone | null,
  currentLeafCount: number,
  maxPanes: number,
  isTargetPlaceholder: boolean,
): { modifier: string; cells: PreviewCell[] } {
  if (isTargetPlaceholder && currentLeafCount >= maxPanes) {
    return {
      modifier: 'drop-preview-grid--single',
      cells: [{ key: 'target', state: 'target' }],
    };
  }

  if (currentLeafCount === 2 && maxPanes >= 4) {
    const target = isQuadrantZone(activeZone) ? activeZone : 'bottom-left';
    return {
      modifier: 'drop-preview-grid--4',
      cells: buildGridCells(QUADRANT_ZONES, target, Math.min(2, currentLeafCount)),
    };
  }

  if (currentLeafCount >= 4) {
    const target = isQuadrantZone(activeZone) ? activeZone : 'bottom-right';
    return {
      modifier: 'drop-preview-grid--4',
      cells: buildGridCells(QUADRANT_ZONES, target, 3),
    };
  }

  const zone = activeZone ?? 'right';
  const vertical = zone === 'top' || zone === 'bottom';
  const firstKey = vertical ? 'top' : 'left';
  const secondKey = vertical ? 'bottom' : 'right';
  const targetKey = zone === firstKey ? firstKey : secondKey;

  return {
    modifier: vertical ? 'drop-preview-grid--2v' : 'drop-preview-grid--2h',
    cells: [firstKey, secondKey].map(key => ({
      key,
      state: key === targetKey ? 'target' : 'existing',
    })),
  };
}

function buildGridCells(zones: DropZone[], target: DropZone, existingCount: number): PreviewCell[] {
  const existingZones = new Set(zones.filter(zone => zone !== target).slice(0, existingCount));

  return zones.map(zone => ({
    key: zone,
    state: zone === target
      ? 'target'
      : existingZones.has(zone)
        ? 'existing'
        : 'placeholder',
  }));
}

function isQuadrantZone(zone: DropZone | null): zone is DropZone {
  return zone !== null && QUADRANT_ZONES.includes(zone);
}
