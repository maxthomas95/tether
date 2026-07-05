import { describe, expect, it } from 'vitest';
import { readLastLines, type PreviewBuffer, type PreviewBufferLine } from './terminal-preview';

/** A raw row: text plus whether it's a wrapped continuation of the row above. */
type RawLine = [text: string, isWrapped?: boolean];

function mkBuffer(rows: RawLine[]): PreviewBuffer {
  const lines: PreviewBufferLine[] = rows.map(([text, isWrapped = false]) => ({
    isWrapped,
    translateToString: () => text,
  }));
  return {
    length: lines.length,
    getLine: (y: number) => lines[y],
  };
}

describe('readLastLines', () => {
  it('returns [] for an empty buffer', () => {
    expect(readLastLines(mkBuffer([]), 6)).toEqual([]);
  });

  it('returns [] for an all-blank buffer', () => {
    const buffer = mkBuffer([[''], ['   '], ['']]);
    expect(readLastLines(buffer, 6)).toEqual([]);
  });

  it('skips trailing blank lines then collects content', () => {
    const buffer = mkBuffer([['first'], ['second'], [''], ['   ']]);
    expect(readLastLines(buffer, 6)).toEqual(['first', 'second']);
  });

  it('returns at most maxLines lines', () => {
    const buffer = mkBuffer([['a'], ['b'], ['c'], ['d'], ['e']]);
    expect(readLastLines(buffer, 3)).toEqual(['c', 'd', 'e']);
  });

  it('returns lines in top-to-bottom order', () => {
    const buffer = mkBuffer([['one'], ['two'], ['three']]);
    expect(readLastLines(buffer, 10)).toEqual(['one', 'two', 'three']);
  });

  it('joins wrapped continuation rows into one logical line', () => {
    const buffer = mkBuffer([
      ['prompt> '],
      ['a very long line that ', false],
      ['wraps onto the next row', true],
      ['done'],
    ]);
    expect(readLastLines(buffer, 10)).toEqual([
      'prompt> ',
      'a very long line that wraps onto the next row',
      'done',
    ]);
  });

  it('caps a merged logical line at 400 characters', () => {
    const half = 'x'.repeat(250);
    const buffer = mkBuffer([
      [half, false],
      [half, true],
    ]);
    const [line] = readLastLines(buffer, 10);
    expect(line).toHaveLength(400);
  });

  it('collects the last maxLines NON-EMPTY logical lines, skipping blanks in between', () => {
    const buffer = mkBuffer([
      ['keep-1'],
      [''],
      ['keep-2'],
      ['   '],
      ['keep-3'],
      [''],
    ]);
    expect(readLastLines(buffer, 2)).toEqual(['keep-2', 'keep-3']);
  });
});
