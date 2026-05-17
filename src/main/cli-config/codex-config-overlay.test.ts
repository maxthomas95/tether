import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-overlay-home-'));

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'home' ? fakeHome : '') },
}));

import { installCodexHooks, uninstallCodexHooks } from './codex-config-overlay';

const HELPER = 'C:\\Program Files\\Tether\\resources\\tether-cli-hook\\index.js';

interface TestCtx {
  configPath: string;
  cleanup: () => void;
}

function setup(): TestCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-overlay-'));
  return {
    configPath: path.join(dir, 'config.toml'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const ctxs: TestCtx[] = [];
beforeEach(() => { ctxs.length = 0; });
afterEach(() => { for (const c of ctxs) c.cleanup(); });
function makeCtx(): TestCtx { const c = setup(); ctxs.push(c); return c; }

function read(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

// Most tests assert "exactly one top-level notify entry survives." Pulled out
// to one helper so we don't trip Sonar's duplicated-blocks detector.
function expectSingleNotifyLine(text: string): void {
  const matches = text.match(/^notify\s*=/gm) || [];
  expect(matches.length).toBe(1);
}

describe('Codex config overlay', () => {
  it('creates a fresh config.toml with notify when none exists', async () => {
    const { configPath } = makeCtx();
    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    expect(text).toContain('notify = ');
    expect(text).toContain('tether-cli-hook');
    expect(text).toContain('--codex');
    expect(text).toContain('node');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes backslashes in Windows-style helper paths', async () => {
    const { configPath } = makeCtx();
    await installCodexHooks({ helperPath: HELPER, configPath });
    const text = read(configPath);
    // The single backslash in the original path must appear as double-escaped
    // in the TOML basic string so it round-trips back to the original.
    expect(text).toContain('\\\\Program Files\\\\');
  });

  it('preserves the user\'s existing top-level keys and sections', async () => {
    const { configPath } = makeCtx();
    const original = [
      '# my codex config',
      'model = "gpt-5"',
      'approval_policy = "on-failure"',
      '',
      '[shell_environment_policy]',
      'inherit = "core"',
      '',
      '[mcp_servers.local]',
      'command = "node"',
      'args = ["server.js"]',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    // Original content preserved verbatim
    expect(text).toContain('# my codex config');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('approval_policy = "on-failure"');
    expect(text).toContain('[shell_environment_policy]');
    expect(text).toContain('inherit = "core"');
    expect(text).toContain('[mcp_servers.local]');
    expect(text).toContain('command = "node"');
    expect(text).toContain('args = ["server.js"]');
    // Notify appears in the top-level block (before the first [section])
    const notifyIdx = text.indexOf('notify =');
    const firstSectionIdx = text.indexOf('[shell_environment_policy]');
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(notifyIdx).toBeLessThan(firstSectionIdx);
  });

  it('is idempotent: calling install twice yields exactly one notify entry', async () => {
    const { configPath } = makeCtx();
    await installCodexHooks({ helperPath: HELPER, configPath });
    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    expectSingleNotifyLine(text);
  });

  it('does not displace a user-owned notify entry, but still scrubs orphans', async () => {
    const { configPath } = makeCtx();
    // Pre-seed: user has their own notify AND a stale Tether one from a crash.
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      'notify = ["python3", "/home/me/my-notifier.py"]',
      'notify = ["node", "/old/tether-cli-hook/index.js", "--codex"]',
      '',
      '[mcp_servers.local]',
      'command = "x"',
      '',
    ].join('\n'));

    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    // User's notify preserved
    expect(text).toContain('"python3"');
    expect(text).toContain('my-notifier.py');
    // Stale tether entry removed
    expect(text).not.toContain('/old/tether-cli-hook');
    // We did NOT add our fresh entry on top of theirs — exactly one notify line.
    expectSingleNotifyLine(text);
    // Section preserved
    expect(text).toContain('[mcp_servers.local]');
  });

  it('does not treat a `notify` key inside a section as the top-level notify', async () => {
    const { configPath } = makeCtx();
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      '',
      '[some.section]',
      'notify = "should-not-be-touched"',
      '',
    ].join('\n'));

    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    // The in-section notify must be untouched.
    expect(text).toContain('notify = "should-not-be-touched"');
    // And we added our own top-level notify (sentinel present).
    expect(text).toContain('tether-cli-hook');
    // And our notify lands before the first section.
    const ourNotifyIdx = text.indexOf('tether-cli-hook');
    const sectionIdx = text.indexOf('[some.section]');
    expect(ourNotifyIdx).toBeLessThan(sectionIdx);
  });

  it('uninstall removes Tether-managed notify but leaves the user\'s', async () => {
    const { configPath } = makeCtx();
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      'notify = ["python3", "/home/me/notifier.py"]',
      '',
    ].join('\n'));

    // User-owned notify means install bails — uninstall on this file is a no-op.
    await installCodexHooks({ helperPath: HELPER, configPath });
    await uninstallCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    expect(text).toContain('"python3"');
    expect(text).not.toContain('tether-cli-hook');
  });

  it('uninstall on a config containing only our notify removes just our line', async () => {
    const { configPath } = makeCtx();
    await installCodexHooks({ helperPath: HELPER, configPath });
    await uninstallCodexHooks({ helperPath: HELPER, configPath });

    const text = fs.existsSync(configPath) ? read(configPath) : '';
    expect(text).not.toContain('tether-cli-hook');
    expect(text).not.toMatch(/^notify\s*=/m);
  });

  it('crash-recovery: install at next launch scrubs orphan entries before reinstalling', async () => {
    const { configPath } = makeCtx();
    // Multiple stale Tether entries pointing at different old helper paths.
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      'notify = ["node", "/old/path/tether-cli-hook/index.js", "--codex"]',
      'notify = ["node", "/even/older/tether-cli-hook/index.js", "--codex"]',
      '',
      '[mcp_servers.local]',
      'command = "x"',
      '',
    ].join('\n'));

    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    expect(text).not.toContain('/old/path/tether-cli-hook');
    expect(text).not.toContain('/even/older/tether-cli-hook');
    expectSingleNotifyLine(text);
    expect(text).toContain('Program Files');
  });

  it('uninstall is a no-op when config.toml is missing', async () => {
    const { configPath } = makeCtx();
    await uninstallCodexHooks({ helperPath: HELPER, configPath });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('round-trips: install + uninstall returns to (essentially) the original file', async () => {
    const { configPath } = makeCtx();
    const original = [
      '# my codex config',
      'model = "gpt-5"',
      '',
      '[shell_environment_policy]',
      'inherit = "core"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    await installCodexHooks({ helperPath: HELPER, configPath });
    await uninstallCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    // Original content all still present
    expect(text).toContain('# my codex config');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[shell_environment_policy]');
    expect(text).toContain('inherit = "core"');
    // No tether trace
    expect(text).not.toContain('tether-cli-hook');
  });

  it('serializes concurrent installs (mutex)', async () => {
    const { configPath } = makeCtx();
    await Promise.all([
      installCodexHooks({ helperPath: HELPER, configPath }),
      installCodexHooks({ helperPath: HELPER, configPath }),
      installCodexHooks({ helperPath: HELPER, configPath }),
      installCodexHooks({ helperPath: HELPER, configPath }),
      installCodexHooks({ helperPath: HELPER, configPath }),
    ]);
    const text = read(configPath);
    expectSingleNotifyLine(text);
  });

  it('handles a multi-line array Tether-managed notify entry on scrub', async () => {
    const { configPath } = makeCtx();
    // Pre-seed with a multi-line stale array (some users format this way).
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      'notify = [',
      '  "node",',
      '  "/old/tether-cli-hook/index.js",',
      '  "--codex"',
      ']',
      '',
      '[section]',
      'k = "v"',
      '',
    ].join('\n'));

    await installCodexHooks({ helperPath: HELPER, configPath });

    const text = read(configPath);
    expect(text).not.toContain('/old/tether-cli-hook');
    // Section preserved
    expect(text).toContain('[section]');
    expect(text).toContain('k = "v"');
    // Exactly one notify (ours)
    expectSingleNotifyLine(text);
    expect(text).toContain('Program Files');
  });
});
