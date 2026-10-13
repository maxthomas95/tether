import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), execFile: vi.fn() }));
vi.mock('node:fs', () => ({ default: { constants: { X_OK: 1 }, promises: { access: mocks.access } } }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

import { resolveHookNodePath } from './node-runtime';

const directory = path.join(os.tmpdir(), 'node home');
const executable = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');

beforeEach(() => {
  mocks.access.mockReset().mockRejectedValue(new Error('missing'));
  mocks.execFile.mockReset();
});

describe('local hook Node preflight', () => {
  it('returns no runtime for an empty PATH or missing executables', async () => {
    expect(await resolveHookNodePath('')).toBeNull();
    expect(await resolveHookNodePath(directory)).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('does not search the working directory through empty or relative PATH entries', async () => {
    expect(await resolveHookNodePath(['', '.', 'bin', ''].join(path.delimiter))).toBeNull();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('resolves a quoted PATH entry with spaces and directly verifies the executable', async () => {
    mocks.access.mockImplementation(async file => { if (file !== executable) throw new Error('missing'); });
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, 'v24.12.0\n'));
    expect(await resolveHookNodePath(`"${directory}"`)).toBe(executable);
    expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(executable, ['--version'], {
      timeout: 3000, maxBuffer: 1024, windowsHide: true,
    }, expect.any(Function));
  });

  it.each([new Error('timed out'), null])('skips a failed or non-Node candidate and tries the next PATH entry (%s)', async error => {
    const second = path.join(os.tmpdir(), 'working-node');
    const working = path.join(second, process.platform === 'win32' ? 'node.exe' : 'node');
    mocks.access.mockImplementation(async file => {
      if (file !== executable && file !== working) throw new Error('missing');
    });
    mocks.execFile.mockImplementation((file, _args, _options, callback) => {
      if (file === executable) callback(error, 'not a Node version');
      else callback(null, 'v24.12.0\r\n');
    });
    expect(await resolveHookNodePath([directory, second].join(path.delimiter))).toBe(working);
  });
});
