import { describe, expect, it, vi } from 'vitest';
import { installCodexLifecycleHooks, mergeCodexLifecycleHooks, scrubCodexLifecycleHooks } from './codex-lifecycle-overlay';

const HELPER = 'C:\\Program Files\\Tether\\resources\\tether-cli-hook\\index.js';

describe('Codex lifecycle hooks overlay', () => {
  it('reports a malformed lifecycle install as unavailable without writing', async () => {
    const writeAtomic = vi.fn();
    const installed = await installCodexLifecycleHooks({
      helperPath: HELPER, hooksPath: 'test-hooks.json',
      store: { read: () => '{', exists: () => true, writeAtomic },
    });
    expect(installed).toBe(false);
    expect(writeAtomic).not.toHaveBeenCalled();
  });

  it('reports successful fresh and already-installed lifecycle wiring', async () => {
    let content: string | null = null;
    const writeAtomic = vi.fn((_filePath: string, text: string) => { content = text; });
    const ctx = {
      helperPath: HELPER, hooksPath: 'test-hooks.json',
      store: { read: () => content, exists: () => content !== null, writeAtomic },
    };
    expect(await installCodexLifecycleHooks(ctx)).toBe(true);
    expect(await installCodexLifecycleHooks(ctx)).toBe(true);
    expect(writeAtomic).toHaveBeenCalledTimes(1);
  });

  it('adds passive command hooks for Codex lifecycle events', () => {
    const result = mergeCodexLifecycleHooks(null, HELPER);
    expect(result.valid).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: 'command',
      async: true,
      timeout: 2,
    });
    expect(parsed.hooks.Interrupt[0].hooks[0].timeout).toBe(1);
    expect(parsed.hooks.SessionEnd[0].hooks[0].timeout).toBe(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('--codex-hook');
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('tether-cli-hook');
  });

  it('preserves user fields and hooks while scrubbing stale Tether entries', () => {
    const original = JSON.stringify({
      description: 'mine',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node user-hook.js' }] },
          { hooks: [{ type: 'command', command: 'node old/tether-cli-hook/index.js --codex-hook' }] },
        ],
      },
      extra: { keep: true },
    });

    const result = mergeCodexLifecycleHooks(original, HELPER);
    const parsed = JSON.parse(result.text);
    expect(parsed.description).toBe('mine');
    expect(parsed.extra.keep).toBe(true);
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('node user-hook.js');
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain('--codex-hook');
    expect(parsed.hooks.Stop[1].hooks[0].command).not.toContain('old/tether-cli-hook');
  });

  it('removes only Tether-owned lifecycle hook entries', () => {
    const installed = mergeCodexLifecycleHooks(JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node user-hook.js' }] }],
      },
    }), HELPER);
    const scrubbed = scrubCodexLifecycleHooks(installed.text);
    const parsed = JSON.parse(scrubbed.text);
    expect(scrubbed.changed).toBe(true);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('node user-hook.js');
    expect(scrubbed.text).not.toContain('--codex-hook');
  });

  it('fails closed for malformed or non-object JSON', () => {
    expect(mergeCodexLifecycleHooks('{', HELPER)).toMatchObject({ valid: false, changed: false });
    expect(mergeCodexLifecycleHooks('[]', HELPER)).toMatchObject({ valid: false, changed: false });
    expect(scrubCodexLifecycleHooks('{')).toMatchObject({ valid: false, changed: false });
    expect(scrubCodexLifecycleHooks('[]')).toMatchObject({ valid: false, changed: false });
  });

  it('fails closed for malformed nested hooks structures', () => {
    expect(mergeCodexLifecycleHooks(JSON.stringify({ hooks: [] }), HELPER)).toMatchObject({ valid: false, changed: false });
    expect(mergeCodexLifecycleHooks(JSON.stringify({ hooks: { Stop: {} } }), HELPER)).toMatchObject({ valid: false, changed: false });
    expect(mergeCodexLifecycleHooks(JSON.stringify({ hooks: { Stop: ['bad-group'] } }), HELPER)).toMatchObject({ valid: false, changed: false });
    expect(mergeCodexLifecycleHooks(JSON.stringify({ hooks: { Stop: [{ hooks: {} }] } }), HELPER)).toMatchObject({ valid: false, changed: false });
  });

  it('reports unchanged when lifecycle hooks are already installed', () => {
    const first = mergeCodexLifecycleHooks(null, HELPER);
    const second = mergeCodexLifecycleHooks(first.text, HELPER);
    expect(second.valid).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });
});
