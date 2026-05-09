import { describe, expect, it } from 'vitest';
import { nextDuplicateLabel, stripCopySuffix } from './duplicate-label';

describe('stripCopySuffix', () => {
  it('removes "(copy)" suffix', () => {
    expect(stripCopySuffix('feature work (copy)')).toBe('feature work');
  });

  it('removes "(copy N)" suffix', () => {
    expect(stripCopySuffix('feature work (copy 3)')).toBe('feature work');
  });

  it('leaves labels without a copy suffix unchanged', () => {
    expect(stripCopySuffix('main')).toBe('main');
    expect(stripCopySuffix('something (older)')).toBe('something (older)');
  });
});

describe('nextDuplicateLabel', () => {
  it('appends "(copy)" on first duplication', () => {
    expect(nextDuplicateLabel('main', [])).toBe('main (copy)');
  });

  it('uses "(copy 2)" when "(copy)" is taken', () => {
    expect(nextDuplicateLabel('main', ['main', 'main (copy)'])).toBe('main (copy 2)');
  });

  it('skips taken numbered copies and picks the next free slot', () => {
    expect(nextDuplicateLabel('main', ['main (copy)', 'main (copy 2)', 'main (copy 3)']))
      .toBe('main (copy 4)');
  });

  it('strips an existing copy suffix from the source label so duplicating a duplicate does not stack', () => {
    expect(nextDuplicateLabel('main (copy 2)', ['main', 'main (copy)', 'main (copy 2)']))
      .toBe('main (copy 3)');
  });

  it('returns "(copy)" form even when the base label is empty after stripping', () => {
    expect(nextDuplicateLabel('(copy)', [])).toBe('(copy) (copy)');
  });
});
