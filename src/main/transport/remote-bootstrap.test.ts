import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { buildRemoteBootstrap } from './remote-bootstrap';
import { quotePosixShellArg } from './posix-shell';

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
describe('secure remote bootstrap', () => {
  it('bounds launch size before any transport sends it', () => {
    expect(() => buildRemoteBootstrap('x'.repeat(1024 * 1024))).toThrow('exceeds');
  });

  it.skipIf(!fs.existsSync(bash))('preserves long multiline values on a real PTY without echo or interactive history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-bootstrap-'));
    const history = path.join(dir, 'history');
    // Git Bash's MSYS sh ignores CR while parsing eval; native POSIX shells do not.
    const secret = "synthetic-secret ' $HOME `never-run`\n" + (process.platform === 'win32' ? '' : '\r') +
      'Unicode café 漢字\n' + 'long value '.repeat(1600) + '\n\n';
    const expected = crypto.createHash('sha256').update(secret).digest('hex');
    const cli = [process.execPath, '-e', "process.stdout.write(String.fromCharCode(13,10)+'DIGEST='+require('node:crypto').createHash('sha256').update(process.env.CONNECTION_STRING).digest('hex'));process.exitCode=7"].map(quotePosixShellArg).join(' ');
    const bootstrap = buildRemoteBootstrap(`env ${quotePosixShellArg('CONNECTION_STRING=' + secret)} ${cli}`, true);
    expect(bootstrap.command).not.toContain('synthetic-secret');
    expect(bootstrap.payload.split('\n').every(line => line.length < 2048)).toBe(true);
    const proc = spawn(bash, ['--noprofile', '--norc', '-i'], { name: 'xterm', cols: 100, rows: 30, cwd: dir,
      env: { ...process.env, PS1: 'TETHER_TEST_PROMPT$ ', HISTFILE: history, TERM: 'xterm' } as Record<string, string> });
    let output = ''; let launched = false; let sent = false;
    try {
      const exit = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Real PTY bootstrap timed out')), 25_000);
        proc.onData(data => {
          output += data;
          if (!launched && output.includes('TETHER_TEST_PROMPT$ ')) { launched = true; proc.write('history -a; ' + bootstrap.command); }
          if (!sent && output.includes(bootstrap.readyMarker)) { sent = true; proc.write(bootstrap.payload); }
        });
        proc.onExit(info => { clearTimeout(timer); resolve(info.exitCode); });
      });
      expect(sent).toBe(true); expect(exit).toBe(7); expect(output).toContain('DIGEST=' + expected);
      expect(output).not.toContain('synthetic-secret');
      expect(fs.existsSync(history)).toBe(true);
      const recorded = fs.readFileSync(history, 'utf8');
      expect(recorded).not.toContain('synthetic-secret');
      expect(recorded).not.toContain(bootstrap.payload.split('\n')[0]);
    } finally { try { proc.kill(); } catch { /* already exited */ } fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
