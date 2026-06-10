import { describe, expect, it, vi } from 'vitest';

// The overlay modules import getClaudeHome/getCodexHome (which reach for
// electron's app) only for the DEFAULT path; the pure functions below don't
// touch it, but the import graph does, so stub electron like the other
// overlay tests do.
vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

import {
  mergeClaudeSettings,
  scrubClaudeSettings,
  installClaudeHooks,
} from './claude-settings-overlay';
import {
  mergeCodexConfig,
  scrubCodexConfig,
  installCodexHooks,
} from './codex-config-overlay';
import type { ConfigFileStore } from './overlay-common';

const CLAUDE_CMD = 'node "/abs/tether-cli-hook/index.js" --claude';
const CODEX_HELPER = '/abs/tether-cli-hook/index.js';

describe('mergeClaudeSettings (pure)', () => {
  it('creates fresh settings with our hooks from null input', () => {
    const out = JSON.parse(mergeClaudeSettings(null, CLAUDE_CMD));
    expect(out.hooks.Notification).toHaveLength(1);
    expect(out.hooks.Stop).toHaveLength(1);
    // Stop is wrapped in the {hooks:[...]} shape Claude's runtime requires.
    expect(Array.isArray(out.hooks.Stop[0].hooks)).toBe(true);
    expect(out.hooks.Stop[0].hooks[0].command).toBe(CLAUDE_CMD);
  });

  it('is idempotent: merging twice yields one entry per array', () => {
    const once = mergeClaudeSettings(null, CLAUDE_CMD);
    const twice = mergeClaudeSettings(once, CLAUDE_CMD);
    const out = JSON.parse(twice);
    expect(out.hooks.Notification).toHaveLength(1);
    expect(out.hooks.Stop).toHaveLength(1);
  });

  it('preserves unrelated keys and existing user hooks', () => {
    const input = JSON.stringify({
      model: 'sonnet',
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: '/usr/bin/their-notify' }] }],
        UserPromptSubmit: [{ type: 'command', command: '/usr/bin/audit' }],
      },
    });
    const out = JSON.parse(mergeClaudeSettings(input, CLAUDE_CMD));
    expect(out.model).toBe('sonnet');
    expect(out.hooks.Notification).toHaveLength(2); // theirs + ours
    expect(out.hooks.UserPromptSubmit[0].command).toBe('/usr/bin/audit');
  });

  it('throws on unparseable input (never returns mangled output)', () => {
    expect(() => mergeClaudeSettings('{ not json', CLAUDE_CMD)).toThrow();
  });

  it('uses the supplied helper command verbatim (platform-quoting decided upstream)', () => {
    const posixCmd = "node '/abs/tether-cli-hook/index.js' --claude";
    const out = JSON.parse(mergeClaudeSettings(null, posixCmd));
    expect(out.hooks.Notification[0].hooks[0].command).toBe(posixCmd);
  });
});

describe('scrubClaudeSettings (pure)', () => {
  it('removes only Tether-managed entries, keeps the user\'s', () => {
    const merged = mergeClaudeSettings(JSON.stringify({
      hooks: { Stop: [{ type: 'command', command: '/usr/bin/their-stop' }] },
    }), CLAUDE_CMD);
    const { text, changed } = scrubClaudeSettings(merged);
    expect(changed).toBe(true);
    const out = JSON.parse(text) as { hooks: { Stop: Array<{ command?: string }> } };
    const commands = out.hooks.Stop.map(e => e.command).filter(Boolean);
    expect(commands).toEqual(['/usr/bin/their-stop']);
  });

  it('reports changed=false for null/empty', () => {
    expect(scrubClaudeSettings(null)).toEqual({ text: '', changed: false });
  });

  it('throws on unparseable input', () => {
    expect(() => scrubClaudeSettings('not json')).toThrow();
  });
});

describe('mergeCodexConfig (pure)', () => {
  it('creates a fresh notify line from null input', () => {
    const { text, changed } = mergeCodexConfig(null, CODEX_HELPER);
    expect(changed).toBe(true);
    expect(text).toContain('notify = ');
    expect(text).toContain('tether-cli-hook');
    expect(text).toContain('--codex');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses to displace a user-owned notify (no orphans → changed=false)', () => {
    const input = ['model = "gpt-5"', 'notify = ["python3", "/me/n.py"]', ''].join('\n');
    const { text, changed } = mergeCodexConfig(input, CODEX_HELPER);
    expect(changed).toBe(false);
    expect(text).toBe(input);
  });

  it('scrubs an orphan but still refuses to add ours alongside a user notify', () => {
    const input = [
      'notify = ["python3", "/me/n.py"]',
      'notify = ["node", "/old/tether-cli-hook/index.js", "--codex"]',
      '',
    ].join('\n');
    const { text, changed } = mergeCodexConfig(input, CODEX_HELPER);
    expect(changed).toBe(true);
    expect(text).not.toContain('/old/tether-cli-hook');
    expect(text).toContain('/me/n.py');
    expect((text.match(/^notify\s*=/gm) || []).length).toBe(1);
  });

  it('is idempotent: merging our output again yields one notify line', () => {
    const once = mergeCodexConfig(null, CODEX_HELPER).text;
    const twice = mergeCodexConfig(once, CODEX_HELPER);
    expect((twice.text.match(/^notify\s*=/gm) || []).length).toBe(1);
  });

  it('does not touch a notify inside a [section]', () => {
    const input = ['model = "x"', '', '[s]', 'notify = "leave-me"', ''].join('\n');
    const { text } = mergeCodexConfig(input, CODEX_HELPER);
    expect(text).toContain('notify = "leave-me"');
    expect(text).toContain('tether-cli-hook');
  });
});

describe('scrubCodexConfig (pure)', () => {
  it('removes a Tether notify, returns changed=true', () => {
    const merged = mergeCodexConfig(null, CODEX_HELPER).text;
    const { text, changed } = scrubCodexConfig(merged);
    expect(changed).toBe(true);
    expect(text).not.toContain('tether-cli-hook');
  });

  it('changed=false when there is nothing of ours', () => {
    const input = 'model = "x"\n';
    expect(scrubCodexConfig(input)).toEqual({ text: input, changed: false });
  });
});

/**
 * In-memory ConfigFileStore so we can assert the I/O wrappers route through
 * read/exists/writeAtomic without touching the disk.
 */
function makeMockStore(seed: Record<string, string> = {}): ConfigFileStore & {
  files: Map<string, string>;
  writes: string[];
} {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  return {
    files,
    writes,
    read: (p) => (files.has(p) ? files.get(p)! : null),
    exists: (p) => files.has(p),
    writeAtomic: (p, text) => { files.set(p, text); writes.push(p); },
  };
}

describe('overlays drive I/O through the ConfigFileStore', () => {
  it('installClaudeHooks reads + atomic-writes via the injected store', async () => {
    const store = makeMockStore();
    const settingsPath = '/fake/settings.json';
    await installClaudeHooks({ helperPath: '/abs/tether-cli-hook/index.js', settingsPath, store });
    expect(store.writes).toEqual([settingsPath]);
    const written = JSON.parse(store.files.get(settingsPath)!);
    expect(written.hooks.Notification).toHaveLength(1);
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it('installClaudeHooks honors an explicit POSIX platform for quoting', async () => {
    const store = makeMockStore();
    const settingsPath = '/fake/settings.json';
    await installClaudeHooks({
      helperPath: '/abs/tether-cli-hook/index.js',
      settingsPath,
      store,
      platform: 'posix',
    });
    const written = JSON.parse(store.files.get(settingsPath)!);
    // POSIX quoting uses single quotes, not cmd.exe double quotes.
    expect(written.hooks.Stop[0].hooks[0].command).toContain("'/abs/tether-cli-hook/index.js'");
  });

  it('installCodexHooks reads + atomic-writes via the injected store', async () => {
    const store = makeMockStore();
    const configPath = '/fake/config.toml';
    await installCodexHooks({ helperPath: CODEX_HELPER, configPath, store });
    expect(store.writes).toEqual([configPath]);
    expect(store.files.get(configPath)).toContain('tether-cli-hook');
  });

  it('installCodexHooks skips the write when a user notify is present (no orphans)', async () => {
    const store = makeMockStore({ '/fake/config.toml': 'notify = ["python3", "/me/n.py"]\n' });
    await installCodexHooks({ helperPath: CODEX_HELPER, configPath: '/fake/config.toml', store });
    // No write at all — we don't displace the user's config.
    expect(store.writes).toEqual([]);
  });

  it('uninstallClaudeHooks via the store leaves the user file untouched when nothing is ours', async () => {
    const store = makeMockStore({ '/fake/settings.json': JSON.stringify({ model: 'sonnet' }) });
    const { uninstallClaudeHooks } = await import('./claude-settings-overlay');
    await uninstallClaudeHooks({ helperPath: '/abs/tether-cli-hook/index.js', settingsPath: '/fake/settings.json', store });
    expect(store.writes).toEqual([]);
  });
});
