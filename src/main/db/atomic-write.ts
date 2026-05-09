import fs from 'node:fs';

const TMP_SUFFIX = '.tmp';
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 50;

export function tmpPathFor(filePath: string): string {
  return filePath + TMP_SUFFIX;
}

/**
 * Write a file atomically: write to `<filePath>.tmp`, fsync, then rename over
 * the target. Rename is atomic on NTFS (libuv → MoveFileExW with
 * MOVEFILE_REPLACE_EXISTING) and POSIX, so a crash mid-write leaves the
 * existing file intact rather than truncated.
 *
 * Retries on transient Windows lock errors (AV / OneDrive holding the file
 * open briefly).
 */
export function atomicWriteFileSync(filePath: string, contents: string): void {
  const tmpPath = tmpPathFor(filePath);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, contents, 'utf-8');
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRY_CODES.has(code) || attempt === RETRY_ATTEMPTS - 1) {
        break;
      }
      sleepSync(RETRY_BACKOFF_MS);
    }
  }

  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  throw lastErr;
}

/**
 * Remove an orphan `<filePath>.tmp` that was left behind by a previous crash
 * mid-write. Safe to call when no orphan exists.
 *
 * Returns `'orphan-only'` if only the tmp exists (no main file) — caller may
 * want to log; we don't auto-recover from it because a partial write could
 * yield invalid JSON.
 */
export function cleanupOrphanTmp(filePath: string): 'none' | 'cleaned' | 'orphan-only' {
  const tmpPath = tmpPathFor(filePath);
  if (!fs.existsSync(tmpPath)) {
    return 'none';
  }
  if (!fs.existsSync(filePath)) {
    return 'orphan-only';
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    return 'none';
  }
  return 'cleaned';
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
