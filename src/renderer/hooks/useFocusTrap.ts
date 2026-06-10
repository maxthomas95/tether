import { useEffect, type RefObject } from 'react';

/**
 * Selector for elements that can receive keyboard focus. Used to find the
 * focusable boundary of a dialog so Tab/Shift+Tab can be cycled within it.
 * `[tabindex="-1"]` is intentionally excluded — those are programmatically
 * focusable but not part of the Tab order.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: HTMLElement): boolean {
  // The element currently holding focus is by definition reachable.
  if (el === document.activeElement) return true;
  // The `hidden` attribute (and display:none, which sets it implicitly via the
  // box model) takes the element out of the tab order. We deliberately do NOT
  // use offsetParent for visibility — position:fixed elements have a null
  // offsetParent in real browsers yet are perfectly focusable, and jsdom never
  // computes layout, which would wrongly exclude everything.
  return !el.hidden;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isVisible);
}

/**
 * Traps keyboard focus inside a dialog container for the lifetime of the
 * mounted dialog. Dependency-free (no focus-trap npm package).
 *
 * While `enabled`:
 *   1. On mount, focuses the first focusable element — UNLESS the dialog
 *      already manages its own initial focus (i.e. the container already
 *      contains document.activeElement, e.g. an autofocused input). If there
 *      is nothing focusable, the container itself is focused (tabIndex=-1).
 *   2. Tab / Shift+Tab cycle within the container's focusable elements so
 *      focus never escapes to the page behind the modal.
 *   3. On unmount (or when disabled), focus is restored to whatever element
 *      was focused before the dialog opened.
 *
 * @param ref      Ref to the dialog container element.
 * @param enabled  Whether the trap is active (typically the dialog's isOpen).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const container = ref.current;
    if (!container) return;

    // Remember where focus was so we can restore it on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Only steal initial focus if the dialog isn't already managing it (e.g.
    // an autofocused input or a button the component focuses itself). This
    // avoids fighting components that set their own initial focus.
    if (!container.contains(document.activeElement)) {
      const focusable = getFocusable(container);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        container.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        // Nothing to cycle through — keep focus pinned on the container.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab off the first element wraps to the last.
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        // Tab off the last element wraps to the first.
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to the opener, but only if it's still in the document
      // and still focusable (it may have been unmounted alongside the dialog).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [enabled, ref]);
}
