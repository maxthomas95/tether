import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-claude-overlay-home-'));

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'home' ? fakeHome : '') },
}));

import { installClaudeHooks, uninstallClaudeHooks } from './claude-settings-overlay';

const HELPER = 'C:\\Program Files\\Tether\\resources\\tether-cli-hook\\index.js';

interface TestCtx {
  settingsPath: string;
  cleanup: () => void;
}

function setup(): TestCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-claude-overlay-'));
  return {
    settingsPath: path.join(dir, 'settings.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const ctxs: TestCtx[] = [];
beforeEach(() => { ctxs.length = 0; });
afterEach(() => { for (const c of ctxs) c.cleanup(); });
function makeCtx(): TestCtx { const c = setup(); ctxs.push(c); return c; }

function readSettings(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Claude settings overlay', () => {
  it('creates a fresh settings.json with our hooks when none exists', async () => {
    const { settingsPath } = makeCtx();
    await installClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath) as { hooks: { Notification: unknown[]; Stop: unknown[] } };
    expect(s.hooks.Notification).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(s)).toContain('tether-cli-hook');
  });

  it('preserves the user\'s existing hooks and unrelated keys', async () => {
    const { settingsPath } = makeCtx();
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: '/usr/bin/their-notify' }] }],
        Stop: [{ type: 'command', command: '/usr/bin/their-stop' }],
        UserPromptSubmit: [{ type: 'command', command: '/usr/bin/audit' }],
      },
    }));

    await installClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath) as {
      model: string;
      hooks: {
        Notification: Array<{ hooks: Array<{ command: string }> }>;
        Stop: Array<{ command: string }>;
        UserPromptSubmit: Array<{ command: string }>;
      };
    };
    expect(s.model).toBe('sonnet');
    // Original notify + ours
    expect(s.hooks.Notification.flatMap(g => g.hooks)).toHaveLength(2);
    expect(s.hooks.Notification[0].hooks[0].command).toBe('/usr/bin/their-notify');
    // Original stop + ours
    expect(s.hooks.Stop.map(e => e.command)).toContain('/usr/bin/their-stop');
    // Unrelated UserPromptSubmit untouched
    expect(s.hooks.UserPromptSubmit[0].command).toBe('/usr/bin/audit');
  });

  it('is idempotent: calling install twice does not duplicate', async () => {
    const { settingsPath } = makeCtx();
    await installClaudeHooks({ helperPath: HELPER, settingsPath });
    await installClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath) as { hooks: { Notification: unknown[]; Stop: unknown[] } };
    expect(s.hooks.Notification).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
  });

  it('uninstall removes our entries but leaves the user\'s', async () => {
    const { settingsPath } = makeCtx();
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: '/usr/bin/their-notify' }] }],
        Stop: [{ type: 'command', command: '/usr/bin/their-stop' }],
      },
    }));

    await installClaudeHooks({ helperPath: HELPER, settingsPath });
    await uninstallClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath) as {
      hooks: { Notification?: Array<{ hooks: Array<{ command: string }> }>; Stop?: Array<{ command: string }> };
    };
    const allNotif = s.hooks.Notification?.flatMap(g => g.hooks) ?? [];
    const allStop = s.hooks.Stop ?? [];
    expect(allNotif.every(h => !h.command.includes('tether-cli-hook'))).toBe(true);
    expect(allStop.every(e => !e.command.includes('tether-cli-hook'))).toBe(true);
    expect(allNotif).toHaveLength(1);
    expect(allStop).toHaveLength(1);
  });

  it('uninstall on a settings file containing only Tether entries removes the hooks key entirely', async () => {
    const { settingsPath } = makeCtx();
    await installClaudeHooks({ helperPath: HELPER, settingsPath });
    await uninstallClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath);
    expect('hooks' in s).toBe(false);
  });

  it('crash-recovery: install at next launch scrubs orphan entries before reinstalling', async () => {
    const { settingsPath } = makeCtx();
    // Simulate orphans by pre-seeding the file with stale tether entries that
    // a crash would have left behind (e.g. with a different helper path).
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Notification: [
          { hooks: [{ type: 'command', command: 'node /old/path/tether-cli-hook/index.js --claude' }] },
          { hooks: [{ type: 'command', command: 'node /even/older/tether-cli-hook/index.js --claude' }] },
        ],
        Stop: [
          { type: 'command', command: 'node /old/path/tether-cli-hook/index.js --claude' },
        ],
      },
    }));

    await installClaudeHooks({ helperPath: HELPER, settingsPath });

    const s = readSettings(settingsPath) as {
      hooks: { Notification: Array<{ hooks: Array<{ command: string }> }>; Stop: Array<{ command: string }> };
    };
    // Exactly one Tether entry on each side — orphans scrubbed.
    expect(s.hooks.Notification.flatMap(g => g.hooks)).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    // And it points at the current helper, not the stale paths.
    expect(s.hooks.Notification[0].hooks[0].command).toContain('Program Files');
    expect(s.hooks.Stop[0].command).toContain('Program Files');
  });

  it('refuses to overwrite an unparseable settings.json', async () => {
    const { settingsPath } = makeCtx();
    fs.writeFileSync(settingsPath, '{ this is not json');
    await expect(installClaudeHooks({ helperPath: HELPER, settingsPath })).rejects.toThrow();
    // File is untouched.
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ this is not json');
  });

  it('uninstall is a no-op when settings.json is missing', async () => {
    const { settingsPath } = makeCtx();
    await uninstallClaudeHooks({ helperPath: HELPER, settingsPath });
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('serializes concurrent installs (mutex)', async () => {
    const { settingsPath } = makeCtx();
    // Fire 5 installs in parallel; result must equal a single install.
    await Promise.all([
      installClaudeHooks({ helperPath: HELPER, settingsPath }),
      installClaudeHooks({ helperPath: HELPER, settingsPath }),
      installClaudeHooks({ helperPath: HELPER, settingsPath }),
      installClaudeHooks({ helperPath: HELPER, settingsPath }),
      installClaudeHooks({ helperPath: HELPER, settingsPath }),
    ]);
    const s = readSettings(settingsPath) as { hooks: { Notification: unknown[]; Stop: unknown[] } };
    expect(s.hooks.Notification).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
  });
});
