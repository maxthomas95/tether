import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { escapeCmdExeArgForNodePty } from '../../shared/shell-quote';

describe.skipIf(process.platform !== 'win32')('Windows launch safety', () => {
  it('passes hostile argv entries directly to an executable without crossing cmd.exe', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'tether-launch-safety-'));
    const sentinel = path.join(fixtureDir, 'sentinel.txt');
    const args = [
      'embedded"quote',
      `foo"&echo x>${sentinel}`,
      'white space',
      '%VAR%',
      '^',
      '&&',
      'unic�de',
      '--flag value',
      path.join(fixtureDir, 'path with spaces'),
    ];

    // Dump argv to a file rather than reading it off the PTY: node-pty
    // interleaves terminal escape sequences into stdout, which would corrupt
    // JSON parsed from the stream.
    const argvOut = path.join(fixtureDir, 'argv.json');

    try {
      await new Promise<void>((resolve, reject) => {
        const pty = spawn(process.execPath, [
          '-e',
          'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))',
          argvOut,
          ...args,
        ], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: fixtureDir,
          env: process.env as Record<string, string>,
        });
        const timer = setTimeout(() => {
          pty.kill();
          reject(new Error('node-pty argv fixture timed out'));
        }, 2_000);
        pty.onData(() => { /* drain */ });
        pty.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
      });

      const received = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(received).toEqual(args);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('rejects double quotes for the batch-shim fallback', () => {
    expect(() => escapeCmdExeArgForNodePty('foo"bar')).toThrow(/double quotes/);
  });
});