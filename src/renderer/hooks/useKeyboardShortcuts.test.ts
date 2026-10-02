// @vitest-environment jsdom
import React, { act, createElement, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBINDINGS, resolveBindings, type Chord, type KeybindingAction } from '../../shared/keybindings';
import { createView } from '../components/visibility.test-helper';
import { useKeyboardShortcuts, type ShortcutActions } from './useKeyboardShortcuts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let actions: ShortcutActions;

function makeActions(): ShortcutActions {
  return {
    onNewSession: vi.fn(),
    onOpenSearch: vi.fn(),
    onFindInTerminal: vi.fn(),
    onSwitchSession: vi.fn(),
    onNextSession: vi.fn(),
    onPrevSession: vi.fn(),
    onNextWaiting: vi.fn(),
    onToggleSidebar: vi.fn(),
    onStopSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onShowShortcuts: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onFocusPaneDirection: vi.fn(),
    onSwapPaneDirection: vi.fn(),
  };
}

function Harness() {
  const bindings = useMemo<Record<KeybindingAction, Chord | null>>(() => ({ ...DEFAULT_KEYBINDINGS }), []);
  useKeyboardShortcuts(actions, bindings, true);
  return null;
}

function keydown(target: EventTarget, key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('shortcut suspension during CLI maintenance', () => {
  it('leaves native terminal chords untouched while suspended and restores app shortcuts afterward', async () => {
    const view = createView();
    const onNewSession = vi.fn();
    const suspendedActions = { onNewSession } as unknown as ShortcutActions;
    const bindings = resolveBindings({});
    function SuspendedHarness({ enabled }: { enabled: boolean }) {
      useKeyboardShortcuts(suspendedActions, bindings, enabled);
      return null;
    }
    try {
      await view.render(React.createElement(SuspendedHarness, { enabled: false }));
      const native = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(native); });
      expect(native.defaultPrevented).toBe(false);
      expect(onNewSession).not.toHaveBeenCalled();

      await view.render(React.createElement(SuspendedHarness, { enabled: true }));
      const app = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(app); });
      expect(app.defaultPrevented).toBe(true);
      expect(onNewSession).toHaveBeenCalledOnce();
    } finally {
      await view.dispose();
    }
  });
});

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    actions = makeActions();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('dispatches terminal find from non-editable content', () => {
    const event = keydown(window, 'F', { ctrlKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(actions.onFindInTerminal).toHaveBeenCalledOnce();
  });

  it('does not open terminal find from form fields or modal content', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const editableEvent = keydown(input, 'F', { ctrlKey: true, shiftKey: true });
    expect(editableEvent.defaultPrevented).toBe(false);
    expect(actions.onFindInTerminal).not.toHaveBeenCalled();

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    const modalEvent = keydown(window, 'F', { ctrlKey: true, shiftKey: true });
    expect(modalEvent.defaultPrevented).toBe(false);
    expect(actions.onFindInTerminal).not.toHaveBeenCalled();
  });

  it('allows xterm helper textareas and blocks pane arrows in ordinary inputs', () => {
    const helper = document.createElement('div');
    helper.className = 'xterm-helper-textarea';
    document.body.appendChild(helper);
    const findEvent = keydown(helper, 'F', { ctrlKey: true, shiftKey: true });
    expect(findEvent.defaultPrevented).toBe(true);
    expect(actions.onFindInTerminal).toHaveBeenCalledOnce();

    const input = document.createElement('input');
    document.body.appendChild(input);
    const arrowEvent = keydown(input, 'ArrowLeft', { ctrlKey: true, altKey: true });
    expect(arrowEvent.defaultPrevented).toBe(false);
    expect(actions.onFocusPaneDirection).not.toHaveBeenCalled();
  });
});
