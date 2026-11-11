import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '', db: {} as Record<string, unknown> }));

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, getVersion: () => '9.9.9' } }));
vi.mock('../db/database', () => ({ getDb: () => mocks.db }));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { defaultExportFilename, exportDiagnostics } from './diagnostics-service';

const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

function entryText(zipPath: string, name: string): string {
  return new AdmZip(zipPath).readAsText(name);
}

beforeEach(() => {
  mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-diagnostics-'));
  mocks.db = {
    config: { theme: 'mocha' }, environments: [], sessions: [], launchProfiles: [],
    gitProviders: [{ id: 'g1', token: 'ghp_plaintexttoken' }],
    defaultEnvVars: { ANTHROPIC_API_KEY: 'literal-secret-value' }, launchSnapshots: {}, workspaceRecipes: [],
  };
});

afterEach(() => {
  fs.rmSync(mocks.userData, { recursive: true, force: true });
});

describe('diagnostics export', () => {
  it('bundles data, the logs that exist, and a manifest describing them', async () => {
    const logs = path.join(mocks.userData, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'tether.log'), `started\nkey=${API_KEY}\n`);
    fs.writeFileSync(path.join(logs, 'tether.1.log'), 'older run\n');
    const destination = path.join(mocks.userData, 'bundle.zip');

    const result = await exportDiagnostics(destination);

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      ok: true, path: destination, files: ['data.json', 'tether.log', 'tether.1.log', 'manifest.json'],
    });
    expect(result.bytes).toBe(fs.statSync(destination).size);
    const data = entryText(destination, 'data.json');
    expect(JSON.parse(data)).toMatchObject({ config: { theme: 'mocha' } });
    expect(data).not.toContain('ghp_plaintexttoken');
    expect(data).not.toContain('literal-secret-value');

    const log = entryText(destination, 'tether.log');
    expect(log).toContain('started');
    expect(log).not.toContain(API_KEY);

    const manifest = JSON.parse(entryText(destination, 'manifest.json'));
    expect(manifest).toMatchObject({ appVersion: '9.9.9', platform: process.platform, arch: process.arch });
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(['data.json', 'tether.log', 'tether.1.log']);
    expect(manifest.scrubbingNotes.length).toBeGreaterThan(0);
  });

  it('still exports when no log has been written yet', async () => {
    const destination = path.join(mocks.userData, 'bundle.zip');

    const result = await exportDiagnostics(destination);

    expect(result.files).toEqual(['data.json', 'manifest.json']);
  });

  it('reports a destination that cannot be written instead of throwing', async () => {
    const blocked = path.join(mocks.userData, 'not-a-folder');
    fs.writeFileSync(blocked, '');

    const result = await exportDiagnostics(path.join(blocked, 'bundle.zip'));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.path).toBeUndefined();
  });

  it('names the bundle with a filename-safe timestamp', () => {
    expect(defaultExportFilename(new Date('2026-05-09T17:30:00.123Z'))).toBe('tether-diagnostics-2026-05-09T17-30-00.zip');
  });
});
