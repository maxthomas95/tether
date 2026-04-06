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
