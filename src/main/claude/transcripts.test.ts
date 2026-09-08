import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-claude-home-'));

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'home' ? fakeHome : '') },
}));

import {
  getClaudeHome,
  getClaudeProjectsRoot,
  getProjectDir,
  listTranscripts,
  transcriptExists,
  transcriptPath,
} from './transcripts';

const overrideDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  overrideDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const dir of overrideDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Claude config dir resolution', () => {
  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(getClaudeHome()).toBe(path.join(fakeHome, '.claude'));
    expect(getClaudeProjectsRoot()).toBe(path.join(fakeHome, '.claude', 'projects'));
  });

  it('honors CLAUDE_CONFIG_DIR when set', () => {
    const override = makeTempDir('tether-claude-override-');
    process.env.CLAUDE_CONFIG_DIR = override;
    expect(getClaudeHome()).toBe(override);
    expect(getClaudeProjectsRoot()).toBe(path.join(override, 'projects'));
  });

  it('reads transcripts from the overridden projects root', () => {
    const override = makeTempDir('tether-claude-override-');
    process.env.CLAUDE_CONFIG_DIR = override;

    const cwd = path.join(override, 'work', 'repo');
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const expectedPath = transcriptPath(cwd, sessionId);
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    expect(expectedPath.startsWith(override)).toBe(true);
    expect(transcriptExists(cwd, sessionId)).toBe(true);
  });

  it('rejects malformed transcript lookup inputs', () => {
    const override = makeTempDir('tether-claude-override-');
    process.env.CLAUDE_CONFIG_DIR = override;

    expect(() => transcriptPath('..\0..', '00000000-0000-4000-8000-000000000001')).toThrow(/working directory/);
    expect(() => transcriptPath(path.join(override, 'work', 'repo'), '..\\evil')).toThrow(/session ID/);
    expect(transcriptExists(path.join(override, 'work', 'repo'), '..\\evil')).toBe(false);
  });
});

describe('Claude transcript path boundaries', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it.each(['', '.', '..', '\0', 'repo\nname'])(
    'rejects an unsafe project directory %j without reading it', (cwd) => {
      expect(() => getProjectDir(cwd)).toThrow('Invalid transcript working directory');
      expect(transcriptExists(cwd, id)).toBe(false);
      expect(listTranscripts(cwd)).toEqual([]);
    },
  );

  it.each(['../outside', '..\\outside', '/absolute', 'C:\\outside', id + '\n', id + ':stream', 'not-a-uuid'])(
    'rejects a path-like or malformed resume ID %j', (sessionId) => {
      expect(() => transcriptPath('/repo', sessionId)).toThrow('Invalid Claude transcript session ID');
      expect(transcriptExists('/repo', sessionId)).toBe(false);
    },
  );

  it('keeps encoded Windows and POSIX working directories inside projects', () => {
    for (const cwd of ['C:\\work\\repo with spaces', '/home/user/日本語', '../repo', '/']) {
      const relative = path.relative(getClaudeProjectsRoot(), transcriptPath(cwd, id));
      expect(relative.split(path.sep)).toHaveLength(2);
      expect(relative.startsWith('..' + path.sep)).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });
});
