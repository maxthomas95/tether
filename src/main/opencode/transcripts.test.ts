import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), warn: vi.fn() }));
vi.mock('../cli/metadata-command', () => ({ runCliMetadata: mocks.run }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { listOpencodeTranscripts, opencodeTranscriptExists } from './transcripts';

const cwd = path.resolve('sample-project');
const row = (id = 'ses_one', updated = 10) => ({ id, directory: cwd, title: 'A session', updated });
function respond(value: unknown) {
  mocks.run.mockResolvedValue({ ok: true, stdout: JSON.stringify(value) });
}

beforeEach(() => { vi.clearAllMocks(); respond([]); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpenCode transcript discovery', () => {
  it('uses the shared metadata command with the existing session-list arguments', async () => {
    respond([row()]);
    expect(await listOpencodeTranscripts(cwd)).toHaveLength(1);
    expect(mocks.run).toHaveBeenCalledWith('opencode', ['session', 'list', '--format', 'json']);
  });

  it.each(['unavailable', 'failed', 'timeout', 'too-large'])('returns no history and false existence on a %s metadata result', async reason => {
    mocks.run.mockResolvedValue({ ok: false, reason });
    await expect(listOpencodeTranscripts(cwd)).resolves.toEqual([]);
    await expect(opencodeTranscriptExists(cwd, 'ses_one')).resolves.toBe(false);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('sorts matching sessions newest first and applies the result limit', async () => {
    respond([row('old', 10), { ...row('elsewhere', 30), directory: path.resolve('other-project') }, row('new', 20)]);
    await expect(listOpencodeTranscripts(cwd, 1)).resolves.toEqual([{
      id: 'new', mtime: '1970-01-01T00:00:00.020Z', preview: 'A session', cliTool: 'opencode', sourcePath: cwd,
    }]);
  });

  it('ignores malformed rows and tolerates unsupported optional metadata', async () => {
    respond([null, 3, {}, { ...row(), id: 4 }, { ...row(), id: '' }, { ...row(), directory: {} },
      { ...row(), directory: '' }, { ...row(), directory: '\u0000bad' }, { ...row(), updated: 1e100, title: {} }]);
    const result = await listOpencodeTranscripts(cwd);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mtime: '1970-01-01T00:00:00.000Z', preview: '' });
  });

  it('uses created timestamps when updated is missing', async () => {
    respond([{ id: 'created', directory: cwd, created: 25 }]);
    expect((await listOpencodeTranscripts(cwd))[0]).toMatchObject({
      id: 'created', mtime: '1970-01-01T00:00:00.025Z', preview: '',
    });
  });

  it('preserves Unicode, normalizes preview whitespace, and truncates long titles', async () => {
    respond([{ ...row('unicode', 20), title: '日本語 \n 🌊' }, { ...row('long', 10), title: `  ${'a'.repeat(201)}  ` }]);
    const results = await listOpencodeTranscripts(cwd);
    expect(results[0].preview).toBe('日本語 🌊');
    expect(results[1].preview).toBe(`${'a'.repeat(200)}…`);
  });

  it.each([true, false])('checks the exact conversation and working directory (exists=%s)', async exists => {
    respond([{ ...row('ses_target'), directory: exists ? cwd : path.resolve('elsewhere') }, row('ses_other')]);
    await expect(opencodeTranscriptExists(cwd, 'ses_target')).resolves.toBe(exists);
  });

  it.each(['win32', 'linux'])('normalizes paths with %s case sensitivity', async platform => {
    vi.stubGlobal('process', { ...process, platform });
    respond([{ ...row(), directory: cwd.toUpperCase() }]);
    expect(await opencodeTranscriptExists(cwd.toLowerCase(), 'ses_one')).toBe(platform === 'win32');
  });

  it.each([{}, null, 1, 'private transcript content'])('returns no history for a non-array response (%s)', async value => {
    respond(value);
    await expect(listOpencodeTranscripts(cwd)).resolves.toEqual([]);
    await expect(opencodeTranscriptExists(cwd, 'ses_one')).resolves.toBe(false);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('logs only a fixed warning for invalid JSON, never transcript content', async () => {
    mocks.run.mockResolvedValue({ ok: true, stdout: 'private transcript content' });
    await expect(listOpencodeTranscripts(cwd)).resolves.toEqual([]);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('opencode session list returned unparseable JSON');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private transcript content');
  });
});
