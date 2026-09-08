import { describe, expect, it } from 'vitest';
import { trimBoundaryCharacter, trimTrailingCharacter } from './string-trim';

describe('linear character trimming', () => {
  it.each([
    ['', '', ''],
    ['////', '', ''],
    ['/secret/folder///', '/secret/folder', 'secret/folder'],
    ['https://example.test///', 'https://example.test', 'https://example.test'],
    ['///folder//item///', '///folder//item', 'folder//item'],
    ['/folder/\n', '/folder/\n', 'folder/\n'],
  ])('preserves interior and non-target characters in %j', (value, suffixResult, edgeResult) => {
    expect(trimTrailingCharacter(value, '/')).toBe(suffixResult);
    expect(trimBoundaryCharacter(value, '/')).toBe(edgeResult);
  });

  it('handles adversarial long interior runs without removing them', () => {
    const interior = 'x' + '/'.repeat(100_000) + 'x';
    expect(trimTrailingCharacter(interior, '/')).toBe(interior);
    expect(trimBoundaryCharacter('///' + interior + '///', '/')).toBe(interior);
    expect(trimBoundaryCharacter('/'.repeat(100_000), '/')).toBe('');
  });

  it('trims slug edges without changing interior hyphens', () => {
    expect(trimBoundaryCharacter('---my--session---', '-')).toBe('my--session');
  });
});
