import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: { cliHooksEnabled: 'true' } as Record<string, string>,
  claudeInstall: vi.fn(async () => true),
  codexInstall: vi.fn(async () => true),
  lifecycleInstall: vi.fn(async () => true),
  bridgeDispose: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => 'test-user-data' } }));
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../db/database', () => ({ getDb: () => ({ config: harness.config }) }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../session/session-manager', () => ({ sessionManager: { handleHookEvent: vi.fn() } }));
vi.mock('./hook-bridge', () => ({
  createHookBridge: async () => ({ socketPath: 'test-socket', token: 'test-token', dispose: harness.bridgeDispose }),
}));
vi.mock('./claude-settings-overlay', () => ({ installClaudeHooks: harness.claudeInstall, uninstallClaudeHooks: vi.fn() }));
vi.mock('./codex-config-overlay', () => ({ installCodexHooks: harness.codexInstall, uninstallCodexHooks: vi.fn() }));
vi.mock('./codex-lifecycle-overlay', () => ({ installCodexLifecycleHooks: harness.lifecycleInstall, uninstallCodexLifecycleHooks: vi.fn() }));

import { envForSession, startHookService, stopHookService } from './hook-service';

beforeEach(() => {
  harness.config = { cliHooksEnabled: 'true' };
  harness.claudeInstall.mockReset().mockResolvedValue(true);
  harness.codexInstall.mockReset().mockResolvedValue(true);
  harness.lifecycleInstall.mockReset().mockResolvedValue(true);
});
afterEach(() => stopHookService());

describe('per-CLI hook wiring', () => {
  it('does not wire Codex when its notify slot belongs to another integration', async () => {
    harness.codexInstall.mockResolvedValue(false);
    await startHookService();
    expect(envForSession('codex-1', 'codex')).toEqual({});
    expect(envForSession('claude-1', 'claude')).toHaveProperty('TETHER_SESSION_ID', 'claude-1');
    expect(envForSession('other', 'custom')).toEqual({});
  });

  it('does not wire Claude when its install fails while Codex succeeds', async () => {
    harness.claudeInstall.mockRejectedValue(new Error('invalid settings'));
    await startHookService();
    expect(envForSession('claude-1', 'claude')).toEqual({});
    expect(envForSession('codex-1', 'codex')).toHaveProperty('TETHER_SESSION_ID', 'codex-1');
  });

  it('can wire Codex through opted-in lifecycle hooks with a user-owned notify', async () => {
    harness.config.codexLifecycleHooksEnabled = 'true';
    harness.codexInstall.mockResolvedValue(false);
    await startHookService();
    expect(envForSession('codex-1', 'codex')).toHaveProperty('TETHER_SESSION_ID', 'codex-1');
  });

  it('does not count malformed lifecycle configuration as successful hook wiring', async () => {
    harness.config.codexLifecycleHooksEnabled = 'true';
    harness.codexInstall.mockResolvedValue(false);
    harness.lifecycleInstall.mockResolvedValue(false);
    await startHookService();
    expect(envForSession('codex-1', 'codex')).toEqual({});
  });

  it('clears capabilities on shutdown and honors a disabled next launch', async () => {
    await startHookService();
    expect(envForSession('claude-1', 'claude')).toHaveProperty('TETHER_SESSION_ID');
    await stopHookService();
    harness.config.cliHooksEnabled = 'false';
    await startHookService();
    expect(envForSession('claude-2', 'claude')).toEqual({});
    expect(envForSession('codex-2', 'codex')).toEqual({});
  });
});
