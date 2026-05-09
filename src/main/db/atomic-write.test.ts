import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync, cleanupOrphanTmp, tmpPathFor } from './atomic-write';

describe('atomic-write', () => {
  let scratchDir: string;
  let target: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-atomic-'));
    target = path.join(scratchDir, 'data.json');
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('atomicWriteFileSync', () => {
    it('writes contents to the target file', () => {
      atomicWriteFileSync(target, '{"hello":"world"}');
      expect(fs.readFileSync(target, 'utf-8')).toBe('{"hello":"world"}');
    });

    it('replaces an existing file', () => {
      fs.writeFileSync(target, 'old contents', 'utf-8');
      atomicWriteFileSync(target, 'new contents');
      expect(fs.readFileSync(target, 'utf-8')).toBe('new contents');
    });

    it('does not leave a tmp file behind on success', () => {
      atomicWriteFileSync(target, 'whatever');
      expect(fs.existsSync(tmpPathFor(target))).toBe(false);
    });

    it('preserves the existing target when rename fails permanently', () => {
      fs.writeFileSync(target, 'original', 'utf-8');

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('disk gone') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      });

      expect(() => atomicWriteFileSync(target, 'new')).toThrow('disk gone');
      expect(fs.readFileSync(target, 'utf-8')).toBe('original');
      expect(fs.existsSync(tmpPathFor(target))).toBe(false);

      renameSpy.mockRestore();
    });

    it('retries on transient EBUSY and eventually succeeds', () => {
      let calls = 0;
      const realRename = fs.renameSync.bind(fs);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((src, dst) => {
        calls += 1;
        if (calls < 2) {
          const err: NodeJS.ErrnoException = new Error('locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return realRename(src, dst);
      }) as typeof fs.renameSync);

      atomicWriteFileSync(target, 'after retry');
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(fs.readFileSync(target, 'utf-8')).toBe('after retry');
      expect(fs.existsSync(tmpPathFor(target))).toBe(false);

      renameSpy.mockRestore();
    });

    it('does not retry on non-transient errors', () => {
      let calls = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        calls += 1;
        const err: NodeJS.ErrnoException = new Error('nope') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      expect(() => atomicWriteFileSync(target, 'x')).toThrow('nope');
      expect(calls).toBe(1);

      renameSpy.mockRestore();
    });
  });

  describe('cleanupOrphanTmp', () => {
    it('returns "none" when no tmp exists', () => {
      expect(cleanupOrphanTmp(target)).toBe('none');
    });

    it('removes a tmp when the target also exists', () => {
      fs.writeFileSync(target, 'real', 'utf-8');
      fs.writeFileSync(tmpPathFor(target), 'partial', 'utf-8');

      expect(cleanupOrphanTmp(target)).toBe('cleaned');
      expect(fs.existsSync(tmpPathFor(target))).toBe(false);
      expect(fs.readFileSync(target, 'utf-8')).toBe('real');
    });

    it('returns "orphan-only" and leaves the tmp when the target is missing', () => {
      fs.writeFileSync(tmpPathFor(target), 'partial', 'utf-8');

      expect(cleanupOrphanTmp(target)).toBe('orphan-only');
      expect(fs.existsSync(tmpPathFor(target))).toBe(true);
    });
  });
});
