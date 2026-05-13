import type { PaneLocation } from '../../lib/layout-tree';

interface PaneLocationBadgeProps {
  location: PaneLocation;
  hidden: boolean;
  onClick: () => void;
}

const SVG_SIZE = 12;
const PAD = 1;
const GAP = 1;
const INNER = SVG_SIZE - 2 * PAD;

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

function cellsForShape(shape: PaneLocation['shape']): Cell[] {
  switch (shape) {
    case 'single':
      return [{ x: PAD, y: PAD, w: INNER, h: INNER }];
    case 'split-h': {
      const w = (INNER - GAP) / 2;
      return [
        { x: PAD, y: PAD, w, h: INNER },
        { x: PAD + w + GAP, y: PAD, w, h: INNER },
      ];
    }
    case 'split-v': {
      const h = (INNER - GAP) / 2;
      return [
        { x: PAD, y: PAD, w: INNER, h },
        { x: PAD, y: PAD + h + GAP, w: INNER, h },
      ];
    }
    case 'grid': {
      const w = (INNER - GAP) / 2;
      const h = (INNER - GAP) / 2;
      return [
        { x: PAD, y: PAD, w, h },
        { x: PAD + w + GAP, y: PAD, w, h },
        { x: PAD, y: PAD + h + GAP, w, h },
        { x: PAD + w + GAP, y: PAD + h + GAP, w, h },
      ];
    }
  }
}

function locationLabel(shape: PaneLocation['shape'], slotIndex: number): string {
  if (shape === 'single') return 'sole pane';
  if (shape === 'split-h') return slotIndex === 0 ? 'left pane' : 'right pane';
  if (shape === 'split-v') return slotIndex === 0 ? 'top pane' : 'bottom pane';
  return ['top-left', 'top-right', 'bottom-left', 'bottom-right'][slotIndex] ?? 'pane';
}

export function PaneLocationBadge({ location, hidden, onClick }: PaneLocationBadgeProps) {
  const cells = cellsForShape(location.shape);
  const where = locationLabel(location.shape, location.slotIndex);
  const title = hidden
    ? `In ${where} — hidden behind another maximized pane. Click to bring it forward.`
    : `In ${where}. Click to focus.`;

  return (
    <button
      type="button"
      className={`pane-location-badge ${hidden ? 'pane-location-badge--hidden' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      title={title}
      aria-label={title}
    >
      <svg width={SVG_SIZE} height={SVG_SIZE} viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`} aria-hidden="true">
        {cells.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={cell.w}
            height={cell.h}
            rx={0.5}
            className={i === location.slotIndex ? 'pane-location-cell--active' : 'pane-location-cell'}
          />
        ))}
      </svg>
    </button>
  );
}
