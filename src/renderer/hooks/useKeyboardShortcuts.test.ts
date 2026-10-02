// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts, type ShortcutActions } from './useKeyboardShortcuts';
import { resolveBindings } from '../../shared/keybindings';
import { createView } from '../components/visibility.test-helper';

describe('shortcut suspension during CLI maintenance', () => {
  it('leaves native terminal chords untouched while suspended and restores app shortcuts afterward', async () => {
    const view = createView();
    const onNewSession = vi.fn();
    const actions = { onNewSession } as unknown as ShortcutActions;
    const bindings = resolveBindings({});
    function Harness({ enabled }: { enabled: boolean }) { useKeyboardShortcuts(actions, bindings, enabled); return null; }
    try {
      await view.render(React.createElement(Harness, { enabled: false }));
      const native = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(native); });
      expect(native.defaultPrevented).toBe(false); expect(onNewSession).not.toHaveBeenCalled();
      await view.render(React.createElement(Harness, { enabled: true }));
      const app = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(app); });
      expect(app.defaultPrevented).toBe(true); expect(onNewSession).toHaveBeenCalledOnce();
    } finally { await view.dispose(); }
  });
});
