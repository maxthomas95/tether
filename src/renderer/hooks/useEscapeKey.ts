import { useEffect, useRef } from 'react';

/**
 * Closes a dialog (or runs any handler) when the user presses Escape.
 * Listens at the document level so focus location doesn't matter.
 *
 * The handler is stored in a ref so callers can pass an inline function
 * without retriggering the effect on every render.
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handlerRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
