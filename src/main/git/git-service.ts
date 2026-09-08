import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CloneProgressInfo, RepoBranchStatus } from '../../shared/types';
import { gitProtocolEnv, validateGitRemoteUrl } from './git-url';

export interface CloneOptions {
  url: string;
  destination: string;
  onProgress?: (info: CloneProgressInfo) => void;
}

const PROGRESS_RE = /(Counting|Compressing|Receiving|Resolving)\s+\w+:\s+(\d+)%/;

const INVALID_GIT_BRANCH_CHARS_RE = /[\s\0-\x1f\x7f~^:?*[\]\\]/;

function validateLocalPath(input: string, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  if (input.includes('\0') || /[\r\n]/.test(input)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (process.platform === 'win32') {
    const normalized = path.win32.normalize(input);
    if (/^\\\\[.?]\\/.test(normalized)) {
      throw new Error(`${label} must not use a Windows device path`);
    }
    if (/^\\(?!\\)/.test(normalized)) {
      throw new Error(`${label} must be drive-absolute or a UNC path`);
    }
    if (!path.win32.isAbsolute(input)) {
      throw new Error(`${label} must be an absolute path`);
    }
    return normalized;
  }
  if (!path.posix.isAbsolute(input)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.posix.normalize(input);
}

function validateBranchName(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Branch name must not be empty');
  }
  if (
    input.startsWith('-') ||
    input.startsWith('/') ||
    input.endsWith('/') ||
    input.endsWith('.') ||
    input.endsWith('.lock') ||
    input === 'HEAD' || input === '@' ||
    input.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) ||
    input.includes('..') ||
    input.includes('@{') ||
    INVALID_GIT_BRANCH_CHARS_RE.test(input)
  ) {
    throw new Error('Branch name is invalid');
  }
  return input;
}

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
    let destination: string;
    try {
      destination = validateLocalPath(opts.destination, 'Destination');
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (fs.existsSync(destination)) {
      return reject(new Error(`Destination already exists: ${destination}`));
    }

    const remoteUrl = validateGitRemoteUrl(opts.url);
    const proc = spawn('git', ['clone', '--progress', '--', remoteUrl, destination], { // NOSONAR(typescript:S4036)
      env: gitProtocolEnv(),
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
        resolve(destination);
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
    let targetDirectory: string;
    try {
      targetDirectory = validateLocalPath(directory, 'Directory');
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (!fs.existsSync(targetDirectory)) {
      fs.mkdirSync(targetDirectory, { recursive: true });
    }

    const proc = spawn('git', ['init', '--', targetDirectory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(targetDirectory);
      else reject(new Error(stderr.trim() || `git init exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

export interface CreateFolderOptions {
  path: string;
  initGit: boolean;
}

export function createFolder(opts: CreateFolderOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let folderPath: string;
    try {
      folderPath = validateLocalPath(opts.path, 'Folder path');
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (fs.existsSync(folderPath)) {
      return reject(new Error(`Folder already exists: ${folderPath}`));
    }

    try {
      fs.mkdirSync(folderPath, { recursive: true });
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (!opts.initGit) {
      return resolve(folderPath);
    }

    // Spawning by binary name (PATH lookup) matches the rest of git-service.ts;
    // Tether shells out to whichever `git` is on the user's PATH.
    const proc = spawn('git', ['init', '--', folderPath], { // NOSONAR(typescript:S4036)
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(folderPath);
      else reject(new Error(stderr.trim() || `git init exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

export function gitRemoteAdd(repoPath: string, remoteName: string, remoteUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let safeRepoPath: string;
    try {
      safeRepoPath = validateLocalPath(repoPath, 'Repository path');
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (!isGitRepo(safeRepoPath)) {
      return reject(new Error(`Not a git repository: ${safeRepoPath}`));
    }
    const safeRemoteUrl = validateGitRemoteUrl(remoteUrl);
    if (!remoteName.trim() || remoteName.startsWith('-') || remoteName.includes('\0') || /[\r\n]/.test(remoteName)) {
      return reject(new Error('Git remote name is invalid'));
    }
    // Spawning by binary name (PATH lookup) matches the rest of git-service.ts.
    const proc = spawn('git', ['remote', 'add', '--', remoteName, safeRemoteUrl], { // NOSONAR(typescript:S4036)
      cwd: safeRepoPath,
      env: gitProtocolEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git remote add exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

export function isGitRepo(directory: string): boolean {
  try {
    const gitPath = path.join(directory, '.git');
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

const BRANCH_STATUS_TIMEOUT_MS = 5_000;

/** Parses `git status --porcelain=v2 --branch` output. Exported for tests. */
export function parsePorcelainStatus(stdout: string): RepoBranchStatus {
  let branch = '';
  let dirtyCount = 0;

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('# branch.head ')) {
        branch = line.slice('# branch.head '.length).trim();
      }
      continue;
    }
    dirtyCount++;
  }

  return { branch, dirtyCount };
}

/**
 * Reads branch + uncommitted-change count for a local repo. Resolves null on
 * any failure (not a repo, spawn error, non-zero exit, timeout) — this is a
 * best-effort sidebar decoration, never worth surfacing an error for.
 */
export function gitBranchStatus(repoPath: string): Promise<RepoBranchStatus | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['-C', repoPath, 'status', '--porcelain=v2', '--branch'], { // NOSONAR(typescript:S4036)
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;

    const finish = (result: RepoBranchStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, BRANCH_STATUS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('close', (code) => {
      finish(code === 0 ? parsePorcelainStatus(stdout) : null);
    });
    proc.on('error', () => finish(null));
  });
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
    let sourceRepo: string;
    let worktreePath: string;
    try {
      sourceRepo = validateLocalPath(opts.sourceRepo, 'Source repository path');
      worktreePath = validateLocalPath(opts.worktreePath, 'Worktree path');
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (!isGitRepo(sourceRepo)) {
      return reject(new Error(`Not a git repository: ${sourceRepo}`));
    }
    if (!fs.existsSync(worktreePath)) {
      return resolve();
    }

    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push('--', worktreePath);

    const proc = spawn('git', args, {
      cwd: sourceRepo,
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
    let sourceRepo: string;
    let worktreePath: string;
    let branch: string;
    try {
      sourceRepo = validateLocalPath(opts.sourceRepo, 'Source repository path');
      worktreePath = validateLocalPath(opts.worktreePath, 'Worktree path');
      branch = validateBranchName(opts.branch);
    } catch (err) {
      return reject(err instanceof Error ? err : new Error(String(err)));
    }

    if (!isGitRepo(sourceRepo)) {
      return reject(new Error(`Not a git repository: ${sourceRepo}`));
    }
    if (fs.existsSync(worktreePath)) {
      return reject(new Error(`Worktree path already exists: ${worktreePath}`));
    }

    const proc = spawn('git', ['worktree', 'add', '-b', branch, '--', worktreePath], {
      cwd: sourceRepo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(worktreePath);
      else reject(new Error(stderr.trim() || `git worktree add exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}
