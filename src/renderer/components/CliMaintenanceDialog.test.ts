// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, change, click, createView, deferred } from './visibility.test-helper';
import type { CliMaintenanceRun } from '../../shared/cli-maintenance';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
const mocks = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), write: vi.fn(), dispose: vi.fn(),
  data: undefined as undefined | ((id: string, phase: CliMaintenanceRun['phase'], bytes: string) => void),
  changed: undefined as undefined | ((run: CliMaintenanceRun) => void) }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 100; rows = 24; options = {}; loadAddon() {} open() {} reset() {} write = mocks.write; dispose = mocks.dispose;
  onData() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
import { CliMaintenanceDialog } from './CliMaintenanceDialog';

const environments: EnvironmentInfo[] = [
  { id: 'ssh', name: 'Linux host', type: 'ssh', config: {}, envVars: {}, sessionCount: 1 },
  { id: 'coder', name: 'Coder', type: 'coder', config: {}, envVars: {}, sessionCount: 0 },
];
let view: ReturnType<typeof createView>;
function control(label: string) {
  return [...view.container.querySelectorAll('label')].find(el => el.firstChild?.textContent === label)!.querySelector('select')!;
}
beforeEach(() => {
  vi.clearAllMocks(); view = createView();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.cancel.mockResolvedValue(undefined);
  window.electronAPI = { platform: 'win32', cliMaintenance: { start: mocks.start, cancel: mocks.cancel, input: vi.fn(), resize: vi.fn(),
    onData: (cb: typeof mocks.data) => { mocks.data = cb; return () => { mocks.data = undefined; }; },
    onChanged: (cb: typeof mocks.changed) => { mocks.changed = cb; return () => { mocks.changed = undefined; }; },
  }, coder: { listWorkspaces: vi.fn().mockResolvedValue([{ owner: 'me', name: 'work', status: 'running' }]) } } as unknown as typeof window.electronAPI;
});
afterEach(async () => { await view.dispose(); vi.unstubAllGlobals(); });

describe('CLI maintenance dialog', () => {
  it('preserves fast raw output and completion events that precede the IPC reply', async () => {
    const pending = deferred<CliMaintenanceRun>(); mocks.start.mockReturnValue(pending.promise);
    await view.render(React.createElement(CliMaintenanceDialog, { environments, sessions: [], theme: {}, onClose: vi.fn() }));
    await click(button(view.container, 'Check version'));
    const request = mocks.start.mock.calls[0][0];
    expect(request).toMatchObject({ tool: 'codex', action: 'check', method: 'native' });
    expect(control('Target').disabled).toBe(true);
    await act(async () => {
      mocks.data!(request.id, 'before', '\x1b[32m原始\r\n');
      mocks.changed!({ id: request.id, status: 'completed', phase: 'before', exitCode: 0 });
      pending.resolve({ id: request.id, status: 'running', phase: 'locate' });
    });
    expect(mocks.write).toHaveBeenCalledWith('\x1b[32m原始\r\n');
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Commands finished');
    expect(control('Target').disabled).toBe(false);
  });
  it('preselects Claude and the SSH session context, and cancels when the dialog closes', async () => {
    const sessions: SessionInfo[] = [{ id: 'session', label: 'Work', workingDir: '/repo', environmentId: 'ssh', state: 'waiting', createdAt: '' }];
    mocks.start.mockImplementation(async request => ({ id: request.id, status: 'running', phase: 'update' }));
    const close = vi.fn();
    await view.render(React.createElement(CliMaintenanceDialog, { environments, sessions, initialSessionId: 'session', theme: {}, onClose: close }));
    expect(control('CLI').value).toBe('claude');
    expect(control('Target').value).toBe('session:session');
    expect([...control('Update method').options].map(o => o.value)).not.toContain('winget');
    await click(button(view.container, 'Update Claude Code'));
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ tool: 'claude', sessionId: 'session', environmentId: 'ssh' });
    await click(button(view.container, 'Cancel and close'));
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.start.mock.calls[0][0].id);
    expect(close).toHaveBeenCalledOnce();
  });
  it('requires an explicit Coder workspace and offers OpenCode upgrade', async () => {
    mocks.start.mockImplementation(async request => ({ id: request.id, status: 'running', phase: 'locate' }));
    await view.render(React.createElement(CliMaintenanceDialog, { environments, sessions: [], initialEnvironmentId: 'coder', theme: {}, onClose: vi.fn() }));
    expect(button(view.container, 'Check version').disabled).toBe(true);
    await change(control('Coder workspace'), 'me/work');
    await change(control('CLI'), 'opencode');
    expect(view.container.querySelector('.cli-maintenance-command code')?.textContent).toBe('opencode upgrade');
    await click(button(view.container, 'Update OpenCode'));
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ tool: 'opencode', action: 'update', workspace: 'me/work', environmentId: 'coder' });
  });
  it('shows launch failures and allows retry without losing focus or leaving listeners behind', async () => {
    mocks.start.mockRejectedValue(new Error('Vault login required'));
    await view.render(React.createElement(CliMaintenanceDialog, { environments, sessions: [], theme: {}, onClose: vi.fn() }));
    await click(button(view.container, 'Check version'));
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Vault login required');
    expect(control('CLI').disabled).toBe(false);
    await view.render(null);
    expect(mocks.data).toBeUndefined(); expect(mocks.changed).toBeUndefined(); expect(mocks.dispose).toHaveBeenCalled();
  });
});
