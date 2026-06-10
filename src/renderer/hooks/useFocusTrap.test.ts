// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, useRef, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFocusTrap } from './useFocusTrap';

// React 19's act() warns unless this global is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Minimal test harness: a dialog component that attaches useFocusTrap to a
 * container holding the children passed in. Renders into a real (jsdom) DOM so
 * focus and keydown behave as in the browser.
 */
function Dialog({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, enabled);
  return createElement('div', { ref, 'data-testid': 'dialog' }, children);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function tab(target: Element, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element on mount', () => {
    render(
      createElement(Dialog, { enabled: true },
        createElement('button', { id: 'first' }, 'First'),
        createElement('button', { id: 'second' }, 'Second'),
      ),
    );
    expect(document.activeElement?.id).toBe('first');
  });

  it('does not steal focus when the container already owns it', () => {
    // Pre-focus an input that will live inside the dialog (simulating autoFocus).
    render(
      createElement(Dialog, { enabled: true },
        createElement('input', { id: 'auto', autoFocus: true }),
        createElement('button', { id: 'btn' }, 'Btn'),
      ),
    );
    // The autofocused input keeps focus; the hook must not yank it to the button.
    expect(document.activeElement?.id).toBe('auto');
  });

  it('wraps focus from the last element back to the first on Tab', () => {
    render(
      createElement(Dialog, { enabled: true },
        createElement('button', { id: 'first' }, 'First'),
        createElement('button', { id: 'last' }, 'Last'),
      ),
    );
    const last = document.getElementById('last')!;
    last.focus();
    const event = tab(last);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('first');
  });

  it('wraps focus from the first element to the last on Shift+Tab', () => {
    render(
      createElement(Dialog, { enabled: true },
        createElement('button', { id: 'first' }, 'First'),
        createElement('button', { id: 'last' }, 'Last'),
      ),
    );
    const first = document.getElementById('first')!;
    first.focus();
    const event = tab(first, true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('last');
  });

  it('restores focus to the previously focused element on unmount', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement?.id).toBe('opener');

    render(
      createElement(Dialog, { enabled: true },
        createElement('button', { id: 'first' }, 'First'),
      ),
    );
    expect(document.activeElement?.id).toBe('first');

    act(() => root.render(null));
    expect(document.activeElement?.id).toBe('opener');
    opener.remove();
  });

  it('does nothing while disabled', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    render(
      createElement(Dialog, { enabled: false },
        createElement('button', { id: 'first' }, 'First'),
      ),
    );
    // Focus stays on the opener; the trap is inert.
    expect(document.activeElement?.id).toBe('opener');
    opener.remove();
  });
});
