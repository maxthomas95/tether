import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const dbState = vi.hoisted(() => ({
  keybindings: {} as Record<string, string | null>,
  saveCount: 0,
}));

vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

import { IPC } from '../../shared/constants';
import { registerKeybindingsHandlers } from './keybindings-handlers';

const harness = createHarness(registry);

function resetDb() {
  dbState.keybindings = {};
  dbState.saveCount = 0;
}

describe('keybindings-handlers', () => {
  beforeEach(() => {
    harness.reset();
    resetDb();
    registerKeybindingsHandlers(harness.ctx);
  });

  it('GET returns the stored overrides map (empty by default)', async () => {
    expect(await harness.invoke(IPC.KEYBINDINGS_GET)).toEqual({});
    dbState.keybindings = { 'session.new': 'ctrl+shift+n', 'session.stop': null };
    expect(await harness.invoke(IPC.KEYBINDINGS_GET)).toEqual({ 'session.new': 'ctrl+shift+n', 'session.stop': null });
  });

  it('SET writes and persists', async () => {
    await harness.invoke(IPC.KEYBINDINGS_SET, { 'session.new': 'ctrl+shift+n' });
    expect(dbState.keybindings).toEqual({ 'session.new': 'ctrl+shift+n' });
    expect(dbState.saveCount).toBe(1);
  });

  it('SET coerces a non-object payload to {}', async () => {
    await harness.invoke(IPC.KEYBINDINGS_SET, null);
    expect(dbState.keybindings).toEqual({});
    expect(dbState.saveCount).toBe(1);
  });

  it('RESET_ALL clears the overrides map and persists', async () => {
    dbState.keybindings = { 'session.new': 'ctrl+shift+n' };
    await harness.invoke(IPC.KEYBINDINGS_RESET_ALL);
    expect(dbState.keybindings).toEqual({});
    expect(dbState.saveCount).toBe(1);
  });
});
