import { useCallback, useRef, useState } from 'react';

interface SplitDividerProps {
  direction: 'horizontal' | 'vertical';
  splitId: string;
  onRatioChange: (splitId: string, ratio: number) => void;
  parentRef: React.RefObject<HTMLDivElement | null>;
}

export function SplitDivider({ direction, splitId, onRatioChange, parentRef }: SplitDividerProps) {
  const [active, setActive] = useState(false);
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setActive(true);

    const handleMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !parentRef.current) return;

      const rect = parentRef.current.getBoundingClientRect();
      let ratio: number;

      if (direction === 'horizontal') {
        ratio = (ev.clientX - rect.left) / rect.width;
      } else {
        ratio = (ev.clientY - rect.top) / rect.height;
      }

      // Clamp to [0.15, 0.85]
      ratio = Math.max(0.15, Math.min(0.85, ratio));
      onRatioChange(splitId, ratio);
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
      setActive(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [direction, splitId, onRatioChange, parentRef]);

  const handleDoubleClick = useCallback(() => {
    onRatioChange(splitId, 0.5);
  }, [splitId, onRatioChange]);

  return (
    <div
      className={`split-divider split-divider--${direction} ${active ? 'split-divider--active' : ''}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    />
  );
}
