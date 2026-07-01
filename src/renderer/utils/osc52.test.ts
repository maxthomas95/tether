import { describe, expect, it } from 'vitest';
import { decodeOsc52Write } from './osc52';

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
});
