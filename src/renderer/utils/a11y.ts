import type { KeyboardEvent } from 'react';

// Mirror a click handler onto Enter/Space key presses so non-interactive
// elements (divs/spans) with onClick remain operable from the keyboard.
export function onKeyActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

// For wrappers whose onClick exists only to stopPropagation — mirror the
// same behavior for keyboard events.
export function stopPropagationOnKey(e: KeyboardEvent) {
  e.stopPropagation();
}
