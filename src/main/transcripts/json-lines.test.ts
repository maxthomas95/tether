import { describe, expect, it } from 'vitest';
import { asRecord, oneLine, parseLine, str, validIso } from './json-lines';

describe('json-lines', () => {
  it('asRecord accepts plain objects only', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    for (const v of [null, undefined, [], 'x', 3]) expect(asRecord(v)).toBeNull();
  });

  it('parseLine returns objects from object lines and null for anything else', () => {
    expect(parseLine('  {"a":1}  ')).toEqual({ a: 1 });
    for (const line of ['', 'text', '[1]', '{broken', '"str"']) expect(parseLine(line)).toBeNull();
  });

  it('str trims and caps, and gives undefined for blanks and non-strings', () => {
    expect(str('  hello  ', 3)).toBe('hel');
    expect(str('   ', 5)).toBeUndefined();
    expect(str(5, 5)).toBeUndefined();
  });

  it('validIso keeps parseable timestamps as written', () => {
    expect(validIso('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(validIso('nope')).toBeNull();
    expect(validIso(3)).toBeNull();
  });

  it('oneLine collapses whitespace and marks a cut', () => {
    expect(oneLine('a \n b\t c', 20)).toBe('a b c');
    expect(oneLine('abcdefghij', 5)).toBe('abcd…');
  });
});
