import { describe, expect, it } from 'vitest';
import { canWriteOsc52Clipboard, decodeOsc52Write } from './osc52';

// Base64 of "hello" is "aGVsbG8=" (verified below to avoid hardcoding wrong).
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('decodeOsc52Write', () => {
  it('decodes a clipboard write with a selection prefix', () => {
    expect(decodeOsc52Write(`c;${b64('hello')}`)).toBe('hello');
  });

  it('decodes UTF-8 (multi-byte) payloads correctly', () => {
    const text = 'café — 日本語 🚀';
    expect(decodeOsc52Write(`c;${b64(text)}`)).toBe(text);
  });

  it('handles multiple selection targets in the prefix', () => {
    // Only the first ";" separates prefix from payload.
    expect(decodeOsc52Write(`pc;${b64('multi')}`)).toBe('multi');
  });

  it('preserves multi-line text', () => {
    const text = 'line one\nline two';
    expect(decodeOsc52Write(`c;${b64(text)}`)).toBe(text);
  });

  it('rejects read requests (Pd === "?") to protect the local clipboard', () => {
    expect(decodeOsc52Write('c;?')).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(decodeOsc52Write('c;')).toBeNull();
  });

  it('returns null for malformed (non-base64) payloads', () => {
    // "!!!!" is not valid base64 — atob throws, we swallow it.
    expect(decodeOsc52Write('c;!!!!')).toBeNull();
  });

  it('treats a payload with no separator as the base64 body', () => {
    expect(decodeOsc52Write(b64('nosep'))).toBe('nosep');
  });

  it('rejects decoded text larger than one million characters', () => {
    expect(decodeOsc52Write(b64('x'.repeat(1_000_001)))).toBeNull();
  });
});

describe('canWriteOsc52Clipboard', () => {
  it('requires document focus and the active element to be in the terminal', () => {
    // This file runs without a DOM; the helper only needs `contains`.
    const input = {} as Element;
    const other = {} as Element;
    const terminal = { contains: (node: unknown) => node === input } as unknown as Element;

    expect(canWriteOsc52Clipboard(true, terminal, input)).toBe(true);
    expect(canWriteOsc52Clipboard(false, terminal, input)).toBe(false);
    expect(canWriteOsc52Clipboard(true, terminal, other)).toBe(false);
    expect(canWriteOsc52Clipboard(true, terminal, null)).toBe(false);
    expect(canWriteOsc52Clipboard(true, undefined, input)).toBe(false);
  });
});
