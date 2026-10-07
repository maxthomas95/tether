import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRemoteCliCommand } from './posix-shell';

const ID = '1f0c2b9e-7a4d-4c3b-9e21-5d6f8a0b3c4d';

describe('buildRemoteCliCommand', () => {
  it('keeps a plain --resume for ids Claude would reject as --session-id', () => {
    expect(buildRemoteCliCommand({ cliTool: 'claude', resumeToolSessionId: 'saved-id' }))
      .toBe("'claude' '--resume' 'saved-id'");
  });

  it('only guards Claude resumes', () => {
    expect(buildRemoteCliCommand({ cliTool: 'codex', binaryName: 'codex', resumeToolSessionId: ID }))
      .toBe(`'codex' 'resume' '${ID}'`);
  });

  it('pins fresh sessions without a transcript check', () => {
    expect(buildRemoteCliCommand({ cliTool: 'claude', toolSessionId: ID }))
      .toBe(`'claude' '--session-id' '${ID}'`);
  });
});

// The remote side is always a POSIX shell, so exercise the generated command
// in one rather than asserting on its text.
describe.skipIf(process.platform === 'win32')('buildRemoteCliCommand in a real shell', () => {
  let dir: string;
  let fakeClaude: string;
  let home: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-resume-'));
    fakeClaude = path.join(dir, 'fake-claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeTranscript(claudeDir: string, project = '-home-vscode-workspaces'): void {
    const file = path.join(claudeDir, 'projects', project, `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }

  function launchArgs(options: Parameters<typeof buildRemoteCliCommand>[0]): string[] {
    const command = buildRemoteCliCommand({ cliTool: 'claude', binaryName: fakeClaude, ...options });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
    return execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' }).trimEnd().split('\n');
  }

  it('starts a fresh conversation under the saved id when no transcript exists', () => {
    expect(launchArgs({ resumeToolSessionId: ID })).toEqual(['--session-id', ID]);
  });

  it('resumes when the transcript exists in any project directory', () => {
    writeTranscript(path.join(home, '.claude'), '-some-other-dir');
    expect(launchArgs({ resumeToolSessionId: ID })).toEqual(['--resume', ID]);
  });

  it('checks the config dir the CLI will actually use', () => {
    const configured = path.join(dir, 'configured');
    writeTranscript(configured);
    expect(launchArgs({ resumeToolSessionId: ID, env: { CLAUDE_CONFIG_DIR: configured } }))
      .toEqual(['--resume', ID]);

    writeTranscript(path.join(home, '.claude'));
    const empty = path.join(dir, 'empty');
    expect(launchArgs({ resumeToolSessionId: ID, env: { CLAUDE_CONFIG_DIR: empty } }))
      .toEqual(['--session-id', ID]);
  });

  it('honors a HOME override when CLAUDE_CONFIG_DIR is unset', () => {
    const otherHome = path.join(dir, 'other-home');
    writeTranscript(path.join(otherHome, '.claude'));
    expect(launchArgs({ resumeToolSessionId: ID, env: { HOME: otherHome } })).toEqual(['--resume', ID]);

    writeTranscript(path.join(home, '.claude'));
    const emptyHome = path.join(dir, 'empty-home');
    expect(launchArgs({ resumeToolSessionId: ID, env: { HOME: emptyHome } })).toEqual(['--session-id', ID]);
  });

  it('keeps user flags before and the initial prompt after the resume pair', () => {
    expect(launchArgs({ resumeToolSessionId: ID, cliArgs: ['--model sonnet'], initialPrompt: "it's $HOME" }))
      .toEqual(['--model', 'sonnet', '--session-id', ID, "it's $HOME"]);
  });
});
