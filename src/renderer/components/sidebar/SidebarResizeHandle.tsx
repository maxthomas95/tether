import { useCallback, useRef } from 'react';
import { clampSidebarWidth } from '../../utils/sidebar-width';

interface SidebarResizeHandleProps {
  onResize: (width: number) => void;
  /** Called once when a drag ends, with the final width. */
  onResizeEnd?: (width: number) => void;
}

export function SidebarResizeHandle({ onResize, onResizeEnd }: Readonly<SidebarResizeHandleProps>) {
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    let lastWidth: number | null = null;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      lastWidth = clampSidebarWidth(e.clientX);
      onResize(lastWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (lastWidth !== null) onResizeEnd?.(lastWidth);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onResize, onResizeEnd]);

  return (
    <div className="sidebar-resize-handle" onMouseDown={onMouseDown} />
  );
}
