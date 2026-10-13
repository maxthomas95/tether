import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { REMOTE_USAGE_PROBE } from './remote-probe';

export const SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** Runs the real probe program in a resident-mode sandbox over the real filesystem. */
export function residentProbe() {
  const lines: string[] = [];
  const handlers: Record<string, (chunk?: string) => void> = {};
  vm.runInNewContext(REMOTE_USAGE_PROBE, {
    require: (name: string) => ({ fs, path, os, crypto })[name as 'fs'], Buffer,
    process: {
      argv: ['node'], platform: 'linux', env: {}, cwd: () => process.cwd(), getuid: () => 1000,
      stdout: { write: (s: string) => { lines.push(...s.split('\n').filter(Boolean)); } },
      stdin: { setEncoding: () => {}, on: (event: string, cb: (chunk?: string) => void) => { handlers[event] = cb; } },
      exit: () => {},
    },
  });
  let nextId = 0;
  return {
    /** Sends one request on the resident stream and returns its parsed reply. */
    ask<T = Record<string, unknown>>(request: object): T & { id?: number; error?: string } {
      const before = lines.length;
      handlers.data(Buffer.from(JSON.stringify({ ...request, id: nextId++ })).toString('base64') + '\n');
      return JSON.parse(lines[before].slice('__TETHER_USAGE__'.length));
    },
    get replyCount() { return lines.length; },
  };
}

export interface SubagentFixture {
  home: string;
  project: string;
  dir: string;
  /** Appends text to an agent transcript, creating it if needed. */
  append(id: string, text: string): void;
  meta(id: string, value: object | string): void;
  request(extra?: object): Record<string, unknown>;
  cleanup(): void;
}

/** A synthetic Claude home with one session folder under a project name nobody could recompute. */
export function subagentFixture(project = 'p-' + 'x'.repeat(210) + '-1a2b3c'): SubagentFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-subagent-remote-'));
  const dir = path.join(home, 'projects', project, SESSION_ID, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return {
    home, project, dir,
    append: (id, text) => fs.appendFileSync(path.join(dir, `agent-${id}.jsonl`), text),
    meta: (id, value) => fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), typeof value === 'string' ? value : JSON.stringify(value)),
    request: (extra = {}) => ({ op: 'subagents', cli: 'claude', sessionId: SESSION_ID, workingDir: '/synthetic/work', claudeHome: home, ...extra }),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
