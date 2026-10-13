import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: { cliHooksEnabled: 'true' } as Record<string, string>,
  claudeInstall: vi.fn(async () => true),
  codexInstall: vi.fn(async () => true),
  lifecycleInstall: vi.fn(async () => true),
  bridgeDispose: vi.fn(async () => undefined),
  claudeUninstall: vi.fn(),
  codexUninstall: vi.fn(),
  lifecycleUninstall: vi.fn(),
  nodePath: vi.fn(async (): Promise<string | null> => 'verified-node'),
  warning: vi.fn(async () => ({ response: 0 })),
  createBridge: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => 'test-user-data' }, dialog: { showMessageBox: harness.warning } }));
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../db/database', () => ({ getDb: () => ({ config: harness.config }) }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../session/session-manager', () => ({ sessionManager: { handleHookEvent: vi.fn() } }));
vi.mock('./hook-bridge', () => ({
  createHookBridge: harness.createBridge,
}));
vi.mock('./claude-settings-overlay', () => ({ installClaudeHooks: harness.claudeInstall, uninstallClaudeHooks: harness.claudeUninstall }));
vi.mock('./codex-config-overlay', () => ({ installCodexHooks: harness.codexInstall, uninstallCodexHooks: harness.codexUninstall }));
vi.mock('./codex-lifecycle-overlay', () => ({ installCodexLifecycleHooks: harness.lifecycleInstall, uninstallCodexLifecycleHooks: harness.lifecycleUninstall }));
vi.mock('./node-runtime', () => ({ resolveHookNodePath: harness.nodePath }));

import { envForSession, isHookServiceActive, startHookService, stopHookService } from './hook-service';

beforeEach(() => {
  harness.config = { cliHooksEnabled: 'true' };
  harness.claudeInstall.mockReset().mockResolvedValue(true);
  harness.codexInstall.mockReset().mockResolvedValue(true);
  harness.lifecycleInstall.mockReset().mockResolvedValue(true);
  harness.claudeUninstall.mockReset();
  harness.codexUninstall.mockReset();
  harness.lifecycleUninstall.mockReset();
  harness.nodePath.mockReset().mockResolvedValue('verified-node');
  harness.warning.mockClear();
  harness.createBridge.mockReset().mockResolvedValue({ socketPath: 'test-socket', token: 'test-token', dispose: harness.bridgeDispose });
});
afterEach(() => stopHookService());

describe('per-CLI hook wiring', () => {
  it('scrubs stale entries but installs nothing and warns once when Node is unavailable', async () => {
    harness.config.codexLifecycleHooksEnabled = 'true';
    harness.nodePath.mockResolvedValue(null);
    await startHookService();
    expect(harness.claudeUninstall).toHaveBeenCalledOnce();
    expect(harness.codexUninstall).toHaveBeenCalledOnce();
    expect(harness.lifecycleUninstall).toHaveBeenCalledOnce();
    expect(harness.createBridge).not.toHaveBeenCalled();
    expect(harness.claudeInstall).not.toHaveBeenCalled();
    expect(harness.codexInstall).not.toHaveBeenCalled();
    expect(harness.lifecycleInstall).not.toHaveBeenCalled();
    expect(harness.warning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'warning', title: 'CLI hooks unavailable' }));
    expect(isHookServiceActive()).toBe(false);
    expect(envForSession('claude-1', 'claude')).toEqual({});
    expect(envForSession('codex-1', 'codex')).toEqual({});
  });

  it('passes the verified Node executable to every local overlay and can recover on the next launch', async () => {
    harness.nodePath.mockResolvedValueOnce(null);
    await startHookService();
    await stopHookService();
    harness.config.codexLifecycleHooksEnabled = 'true';
    await startHookService();
    for (const installer of [harness.claudeInstall, harness.codexInstall, harness.lifecycleInstall]) {
      expect(installer).toHaveBeenCalledWith(expect.objectContaining({ nodePath: 'verified-node' }));
    }
    expect(envForSession('claude-1', 'claude')).toHaveProperty('TETHER_SESSION_ID');
    expect(harness.warning).toHaveBeenCalledOnce();
  });

  it('does not probe Node or show a warning when hooks are disabled', async () => {
    harness.config.cliHooksEnabled = 'false';
    await startHookService();
    expect(harness.nodePath).not.toHaveBeenCalled();
    expect(harness.warning).not.toHaveBeenCalled();
    expect(harness.claudeUninstall).toHaveBeenCalledOnce();
  });

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
