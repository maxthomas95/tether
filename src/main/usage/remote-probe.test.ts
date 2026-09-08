import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { REMOTE_USAGE_PROBE } from './remote-probe';
import type { RemoteUsageReply, RemoteUsageRequest } from './remote-protocol';

const dirs: string[] = [];
function fixture(cli: 'claude' | 'codex', text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-remote-usage-'));
  dirs.push(dir);
  const root = path.join(dir, cli === 'claude' ? 'projects' : 'sessions');
  const file = cli === 'claude'
    ? path.join(root, fs.realpathSync(dir).replace(/[\\/:]/g, '-'), 'native-id.jsonl')
    : path.join(root, '2026', '09', '07', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const request: RemoteUsageRequest = { cli, marker: 'pane-a', workingDir: dir,
    claudeHome: dir, codexHome: dir, nativeSessionId: cli === 'claude' ? 'native-id' : undefined };
  return { dir, file, request };
}

function probe(request: RemoteUsageRequest, processes: Record<string, { marker: string; files: string[] }> = {}) {
  let output = '';
  const remoteFs = {
    ...fs,
    readdirSync: (p: string, ...args: unknown[]) => {
      if (p === '/proc') return Object.keys(processes);
      const pid = /^\/proc\/(\d+)\/fd$/.exec(p)?.[1];
      if (pid) return processes[pid].files.map((_, i) => String(i));
      return (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...args);
    },
    readFileSync: (p: string, ...args: unknown[]) => {
      const pid = /^\/proc\/(\d+)\/environ$/.exec(p)?.[1];
      if (pid) return `SECRET=not-for-transmission\0TETHER_USAGE_SESSION_ID=${processes[pid].marker}\0`;
      return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...args);
    },
    readlinkSync: (p: string) => {
      const match = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p);
      return match ? processes[match[1]].files[Number(match[2])] : fs.readlinkSync(p);
    },
  };
  vm.runInNewContext(REMOTE_USAGE_PROBE, {
    require: (name: string) => ({ fs: remoteFs, path, os, crypto })[name as 'fs'], Buffer,
    process: { argv: ['node', Buffer.from(JSON.stringify(request)).toString('base64')], platform: 'linux', env: {}, cwd: () => process.cwd(),
      getuid: () => 1000, stdout: { write: (s: string) => { output += s; } } },
  });
  return JSON.parse(output.slice('__TETHER_USAGE__'.length)) as RemoteUsageReply;
}

const claude = (tokens: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-09-07T10:00:00Z',
  message: { model: 'claude-sonnet-4', content: [{ text: 'private response' }], usage: { input_tokens: tokens, output_tokens: 7 } } });
const codexHeader = (id: string, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/same', source } }) + '\n';

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('remote usage probe', () => {
  it('strips conversation content on the remote and advances across UTF-8/partial records', () => {
    const prefix = JSON.stringify({ type: 'user', message: 'private prompt 🍁' }) + '\n' + claude(10) + '\n';
    const f = fixture('claude', prefix + claude(20).slice(0, -2));
    const discovery = probe(f.request);
    const first = probe({ ...f.request, source: discovery.source, cursor: { offset: 0, identity: '' } });
    expect(first.offset).toBe(Buffer.byteLength(prefix));
    expect(first.text).not.toMatch(/private|content|SECRET/);
    expect(JSON.parse(first.text!).message.usage.input_tokens).toBe(10);
    fs.appendFileSync(f.file, claude(20).slice(-2) + '\n');
    const next = probe({ ...f.request, source: first.source, cursor: { offset: first.offset!, identity: first.source!.identity } });
    expect(next.reset).toBe(false);
    expect(JSON.parse(next.text!).message.usage.input_tokens).toBe(20);
    const unchanged = probe({ ...f.request, source: next.source, cursor: { offset: next.offset!, identity: next.source!.identity } });
    expect(unchanged.text).toBe('');
    expect(unchanged.offset).toBe(fs.statSync(f.file).size);
  });

  it('resets after truncation or file replacement instead of appending old totals', () => {
    const f = fixture('claude', claude(900) + '\n' + claude(200) + '\n');
    const source = probe(f.request).source;
    const first = probe({ ...f.request, source, cursor: { offset: 0, identity: '' } });
    fs.writeFileSync(f.file, claude(1) + '\n');
    const next = probe({ ...f.request, source: first.source, cursor: { offset: first.offset!, identity: first.source!.identity } });
    expect(next.reset).toBe(true);
    expect(JSON.parse(next.text!).message.usage.input_tokens).toBe(1);
  });

  it('matches Codex by marked process, isolating concurrent panes and excluding subagents', () => {
    const a = fixture('codex', codexHeader('a'));
    const b = path.join(path.dirname(a.file), 'b.jsonl');
    const child = path.join(path.dirname(a.file), 'child.jsonl');
    fs.writeFileSync(b, codexHeader('b'));
    fs.writeFileSync(child, codexHeader('child', { subagent: 'thread' }));
    const processes = { '10': { marker: 'pane-a', files: [a.file, child] }, '20': { marker: 'pane-b', files: [b] } };
    expect(probe(a.request, processes).source?.nativeSessionId).toBe('a');
    expect(probe({ ...a.request, marker: 'pane-b' }, processes).source?.nativeSessionId).toBe('b');
    expect(probe({ ...a.request, marker: 'missing' }, processes).status).toBe('pending');
    expect(probe(a.request, { '10': { marker: 'pane-a', files: [a.file, b] } }).status).toBe('pending');
  });

  it('preserves Codex model events and only numeric token fields', () => {
    const data = codexHeader('a')
      + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', instructions: 'private' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2026-09-07T10:00:00Z', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 9, reasoning_output_tokens: 2, secret: 'private' },
      } } }) + '\n';
    const f = fixture('codex', data);
    const source = probe(f.request, { '10': { marker: 'pane-a', files: [f.file] } }).source;
    const result = probe({ ...f.request, source, cursor: { offset: 0, identity: '' } });
    expect(result.text).not.toMatch(/private|instructions|secret/);
    expect(result.text).toContain('gpt-5');
    expect(result.text).toContain('cached_input_tokens');
    expect(result.offset).toBe(Buffer.byteLength(data));
  });

  it('discovers Codex even when session metadata contains large base instructions', () => {
    const f = fixture('codex', JSON.stringify({ type: 'session_meta', payload: { id: 'large', source: 'cli', base_instructions: 'private'.repeat(20_000) } }) + '\n');
    const result = probe(f.request, { '10': { marker: 'pane-a', files: [f.file] } });
    expect(result.source?.nativeSessionId).toBe('large');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reads beyond a large non-usage line without splitting UTF-8 or losing the following event', () => {
    const f = fixture('claude', JSON.stringify({ type: 'user', content: 'é'.repeat(700_000) }) + '\n' + claude(42) + '\n');
    const source = probe(f.request).source;
    const result = probe({ ...f.request, source, cursor: { offset: 0, identity: '' } });
    expect(JSON.parse(result.text!).message.usage.input_tokens).toBe(42);
    expect(result.offset).toBe(fs.statSync(f.file).size);
  });
});
