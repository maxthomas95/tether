import { expect, it } from 'vitest';
import { slugify } from './vault-path';

it.each([
  [' My SSH Session! ', 'my-ssh-session'],
  ['---my--session---', 'my--session'],
  ['', 'item'],
  ['---', 'item'],
])('keeps the existing Vault slug for %j', (value, expected) => {
  expect(slugify(value)).toBe(expected);
});

it('uses the caller fallback when a name has no slug characters', () => {
  expect(slugify('!!!', 'session')).toBe('session');
});
