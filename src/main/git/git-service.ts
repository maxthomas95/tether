import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CloneProgressInfo } from '../../shared/types';

export interface CloneOptions {
  url: string;
  destination: string;
  onProgress?: (info: CloneProgressInfo) => void;
}

const PROGRESS_RE = /(Counting|Compressing|Receiving|Resolving)\s+\w+:\s+(\d+)%/;

function parsePhase(raw: string): CloneProgressInfo['phase'] {
  const lower = raw.toLowerCase();
  if (lower.startsWith('counting')) return 'counting';
  if (lower.startsWith('compressing')) return 'compressing';
  if (lower.startsWith('receiving')) return 'receiving';
  if (lower.startsWith('resolving')) return 'resolving';
  return 'receiving';
}

export function gitClone(opts: CloneOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(opts.destination)) {
      return reject(new Error(`Destination already exists: ${opts.destination}`));
    }

    const proc = spawn('git', ['clone', '--progress', opts.url, opts.destination], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;

      if (opts.onProgress) {
        const match = PROGRESS_RE.exec(text);
        if (match) {
          opts.onProgress({
            phase: parsePhase(match[1]),
            percent: parseInt(match[2], 10),
            message: text.trim(),
          });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        opts.onProgress?.({ phase: 'done', percent: 100, message: 'Clone complete' });
        resolve(opts.destination);
      } else {
        const errMsg = stderrBuf.trim() || `git clone exited with code ${code}`;
        opts.onProgress?.({ phase: 'error', percent: 0, message: errMsg });
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      opts.onProgress?.({ phase: 'error', percent: 0, message: err.message });
      reject(err);
    });
  });
}

export function gitInit(directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const proc = spawn('git', ['init', directory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(directory);
      else reject(new Error(stderr.trim() || `git init exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

export function isGitRepo(directory: string): boolean {
  try {
    const gitPath = `${directory}/.git`;
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

export interface WorktreeAddOptions {
  sourceRepo: string;
  worktreePath: string;
  branch: string;
}

export interface WorktreeRemoveOptions {
  sourceRepo: string;
  worktreePath: string;
  force?: boolean;
}

export function gitWorktreeRemove(opts: WorktreeRemoveOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isGitRepo(opts.sourceRepo)) {
      return reject(new Error(`Not a git repository: ${opts.sourceRepo}`));
    }
    if (!fs.existsSync(opts.worktreePath)) {
      return resolve();
    }

    const args = ['-C', opts.sourceRepo, 'worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(opts.worktreePath);

    const proc = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git worktree remove exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

export function gitWorktreeAdd(opts: WorktreeAddOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!isGitRepo(opts.sourceRepo)) {
      return reject(new Error(`Not a git repository: ${opts.sourceRepo}`));
    }
    if (fs.existsSync(opts.worktreePath)) {
      return reject(new Error(`Worktree path already exists: ${opts.worktreePath}`));
    }
    if (!opts.branch.trim()) {
      return reject(new Error('Branch name must not be empty'));
    }

    const proc = spawn('git', ['-C', opts.sourceRepo, 'worktree', 'add', '-b', opts.branch, opts.worktreePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(opts.worktreePath);
      else reject(new Error(stderr.trim() || `git worktree add exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}
