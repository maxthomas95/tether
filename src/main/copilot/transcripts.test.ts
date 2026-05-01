import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { copilotTranscriptExists, listCopilotTranscripts } from './transcripts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-copilot-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSession(copilotHome: string, id: string, opts: {
  cwd: string;
  summary?: string;
  events?: string[];
}) {
  const sessionDir = path.join(copilotHome, 'session-state', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const lines = [`cwd: ${opts.cwd.replace(/\\/g, '\\\\')}`];
  if (opts.summary) lines.push(`summary: "${opts.summary}"`);
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), lines.join('\n') + '\n');
  if (opts.events) {
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), opts.events.join('\n'));
  }
  return sessionDir;
}

describe('copilot transcript discovery', () => {
  it('lists copilot sessions whose workspace.yaml cwd matches the working directory', () => {
    const home = makeTempDir();
    const workingDir = path.join(home, 'repo');
    const otherDir = path.join(home, 'other');

    writeSession(home, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
      cwd: workingDir,
      summary: 'Add resume support',
      events: [JSON.stringify({ type: 'user.message', data: { content: 'first prompt' } })],
    });
    writeSession(home, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
      cwd: otherDir,
      events: [],
    });

    const rows = listCopilotTranscripts(workingDir, 50, home);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(rows[0].preview).toBe('Add resume support');
    expect(rows[0].cliTool).toBe('copilot');
  });

  it('falls back to first user.message in events.jsonl when summary is missing', () => {
    const home = makeTempDir();
    const workingDir = path.join(home, 'repo');
    writeSession(home, 'cccccccc-cccc-cccc-cccc-cccccccccccc', {
      cwd: workingDir,
      events: [
        JSON.stringify({ type: 'session.start', data: {} }),
        JSON.stringify({ type: 'user.message', data: { content: 'fix the bug please' } }),
        JSON.stringify({ type: 'assistant.message', data: { content: 'OK' } }),
      ],
    });

    const rows = listCopilotTranscripts(workingDir, 50, home);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe('fix the bug please');
  });

  it('reports transcript existence by id and cwd', () => {
    const home = makeTempDir();
    const workingDir = path.join(home, 'repo');
    writeSession(home, 'dddddddd-dddd-dddd-dddd-dddddddddddd', { cwd: workingDir });
    writeSession(home, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', { cwd: path.join(home, 'other') });

    expect(copilotTranscriptExists(workingDir, 'dddddddd-dddd-dddd-dddd-dddddddddddd', home)).toBe(true);
    expect(copilotTranscriptExists(workingDir, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', home)).toBe(false);
    expect(copilotTranscriptExists(workingDir, 'ffffffff-ffff-ffff-ffff-ffffffffffff', home)).toBe(false);
  });
});
