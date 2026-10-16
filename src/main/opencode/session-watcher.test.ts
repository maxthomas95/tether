import { expect, it, vi } from 'vitest';
vi.mock('./transcripts', () => ({ listOpencodeTranscripts: vi.fn(async () => []) }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../session/detect-new-session', () => ({ detectNewSession: vi.fn(), makeReleaseClaim: () => vi.fn() }));
import { detectNewSession } from '../session/detect-new-session';
import { listOpencodeTranscripts } from './transcripts';
import { detectNewOpencodeSession } from './session-watcher';

it('polls history in the effective OpenCode launch environment', async () => {
  const env = { OPENCODE_DB: 'custom.db' };
  detectNewOpencodeSession({ workingDir: 'project', env });
  await vi.mocked(detectNewSession).mock.calls[0][0].list();
  expect(listOpencodeTranscripts).toHaveBeenCalledWith('project', Number.MAX_SAFE_INTEGER, env);
});
