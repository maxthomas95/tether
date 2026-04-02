import { useCallback, useRef } from 'react';

interface SidebarResizeHandleProps {
  onResize: (width: number) => void;
}

export function SidebarResizeHandle({ onResize }: SidebarResizeHandleProps) {
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const width = Math.max(180, Math.min(400, e.clientX));
      onResize(width);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onResize]);

  return (
    <div className="sidebar-resize-handle" onMouseDown={onMouseDown} />
  );
}
