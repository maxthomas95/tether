import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.userData,
  },
}));

// The real logger opens a file under userData, which this test deletes.
vi.mock('../logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  // The module under test uses the default export, so the built-server check
  // has to be stubbed there as well as on the named export.
  const existsSync = (filePath: fs.PathLike) => String(filePath).endsWith(path.join('dist', 'index.js')) || actual.existsSync(filePath);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock('./bridge', () => ({
  createHelmBridge: vi.fn(async () => ({
    socketPath: 'socket-path',
    token: 'bridge-token',
    dispose: vi.fn(),
  })),
}));

import { setupHelmForSession } from './integration';

afterEach(() => {
  if (state.userData) fs.rmSync(state.userData, { recursive: true, force: true });
  state.userData = '';
});

describe('setupHelmForSession', () => {
  it('clears stale configs only before the first config written in a process', async () => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-helm-integration-'));
    const configsDir = path.join(state.userData, 'helm-mcp-configs');
    fs.mkdirSync(configsDir);
    fs.writeFileSync(path.join(configsDir, 'stale.json'), '{}');
    fs.writeFileSync(path.join(configsDir, 'keep.txt'), 'keep');

    const first = await setupHelmForSession('first', {});
    expect(fs.existsSync(path.join(configsDir, 'stale.json'))).toBe(false);
    expect(fs.existsSync(path.join(configsDir, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(first.mcpConfigPath)).toBe(true);

    fs.writeFileSync(path.join(configsDir, 'later.json'), '{}');
    const second = await setupHelmForSession('second', {});
    expect(fs.existsSync(path.join(configsDir, 'later.json'))).toBe(true);
    expect(fs.existsSync(second.mcpConfigPath)).toBe(true);

    first.cleanup();
    second.cleanup();
  });
});
