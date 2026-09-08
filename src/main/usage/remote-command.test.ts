import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProbeCommand, coderUsageConnection, parseProbeReply } from './remote-command';
import { remoteUsageKey, type RemoteUsageRequest } from './remote-protocol';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: vi.fn() }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: vi.fn() }));
vi.mock('../cli-config/remote/ssh-control-connection', () => ({ connectSshControl: vi.fn() }));

const request: RemoteUsageRequest = { cli: 'codex', marker: 'pane', workingDir: '/work' };
function child() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  spawnMock.mockReturnValueOnce(child);
  return child;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('remote usage command boundary', () => {
  it('passes Coder workspace as an argument and never allocates a PTY or starts a stopped workspace', async () => {
    const process = child();
    const connection = coderUsageConnection('C:\\Tools\\coder.exe', 'owner/work space');
    const pending = connection.poll(request);
    expect(spawnMock).toHaveBeenCalledWith('C:\\Tools\\coder.exe', ['ssh', '--disable-autostart', 'owner/work space', '--', expect.any(String)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write('login banner\n__TETHER_USAGE__{"status":"pending"}\n');
    process.emit('close', 0);
    await expect(pending).resolves.toEqual({ status: 'pending' });
    connection.close();
  });

  it('bounds hung commands and output without exposing remote stderr', async () => {
    vi.useFakeTimers();
    const process = child();
    const pending = coderUsageConnection('coder', 'work').poll(request);
    const checked = expect(pending).rejects.toThrow('timed out');
    process.stderr.write('a remote secret must not reach the error');
    await vi.advanceTimersByTimeAsync(30_000);
    await checked;
    expect(process.kill).toHaveBeenCalledOnce();

    const noisy = child();
    const oversized = coderUsageConnection('coder', 'work').poll(request);
    noisy.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(oversized).rejects.toThrow('exceeded limit');
    expect(noisy.kill).toHaveBeenCalledOnce();
  });

  it('rejects invalid cursors and distinguishes same native id on separate hosts/workspaces/tools', () => {
    const source = { scope: 'user', nativeSessionId: 'same', path: '/rollout.jsonl', identity: 'id' };
    expect(() => parseProbeReply('__TETHER_USAGE__' + JSON.stringify({ status: 'ready', source, offset: -1, text: '' }))).toThrow('cursor');
    const keys = [remoteUsageKey('a', 'w', 'claude', source), remoteUsageKey('b', 'w', 'claude', source), remoteUsageKey('a', 'v', 'claude', source), remoteUsageKey('a', 'w', 'codex', source)];
    expect(new Set(keys).size).toBe(4);
  });

  it('encodes request paths as data and keeps sudo password input off the command line', () => {
    const command = buildProbeCommand({ ...request, workingDir: "~/path' $(touch injected) `whoami`" }, true, true);
    expect(command).toMatch(/^sudo -S -p '' -i -- sh -lc /);
    expect(command).not.toContain('touch injected');
    expect(command.length).toBeLessThan(30_000);
    expect(buildProbeCommand(request, true)).toMatch(/^sudo -n -i/);
  });

  it('runs the quoted probe through a real POSIX shell', async () => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe') : '/bin/sh';
    if (!fs.existsSync(shell)) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-usage-quote'-$-"));
    try {
      const file = path.join(dir, 'projects', fs.realpathSync(dir).replace(/[\\/:]/g, '-'), 'native.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"type":"user","message":"private"}\n');
      const command = buildProbeCommand({ cli: 'claude', marker: 'pane', workingDir: dir, claudeHome: dir, nativeSessionId: 'native' });
      const stdout = execFileSync(shell, ['-s'], { input: command, windowsHide: true, timeout: 10_000, encoding: 'utf8' });
      expect(parseProbeReply(stdout).source?.nativeSessionId).toBe('native');
      expect(stdout).not.toContain('private');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
