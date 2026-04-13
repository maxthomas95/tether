import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { codexTranscriptExists, listCodexTranscripts } from './transcripts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('codex transcript discovery', () => {
  it('lists Codex sessions for the selected working directory', () => {
    const codexHome = makeTempDir();
    const workingDir = path.join(codexHome, 'repo');
    const otherDir = path.join(codexHome, 'other');
    fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '04', '13'), { recursive: true });

    const sessionPath = path.join(codexHome, 'sessions', '2026', '04', '13', 'rollout-2026-04-13T10-00-00-session-a.jsonl');
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'session-a', timestamp: '2026-04-13T10:00:00.000Z', cwd: workingDir },
      }),
      JSON.stringify({ type: 'turn' }),
    ].join('\n'));

    const otherPath = path.join(codexHome, 'sessions', '2026', '04', '13', 'rollout-2026-04-13T11-00-00-session-b.jsonl');
    fs.writeFileSync(otherPath, JSON.stringify({
      timestamp: '2026-04-13T11:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'session-b', timestamp: '2026-04-13T11:00:00.000Z', cwd: otherDir },
    }));

    fs.writeFileSync(path.join(codexHome, 'history.jsonl'), JSON.stringify({
      session_id: 'session-a',
      text: 'Implement Codex support for Tether',
    }));

    const rows = listCodexTranscripts(workingDir, 50, codexHome);

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'session-a',
        cliTool: 'codex',
        preview: 'Implement Codex support for Tether',
        sourcePath: sessionPath,
      }),
    ]);
    expect(codexTranscriptExists(workingDir, 'session-a', codexHome)).toBe(true);
    expect(codexTranscriptExists(workingDir, 'session-b', codexHome)).toBe(false);
  });
});
