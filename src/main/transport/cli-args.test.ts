import { expect, it } from 'vitest';
import { tokenizeCliArgEntries } from './cli-args';

it('preserves equals-form values with spaces while splitting multi-token presets', () => {
  expect(tokenizeCliArgEntries(['--add-dir=C:\\My Projects\\shared', '  ', '--permission-mode plan']))
    .toEqual(['--add-dir=C:\\My Projects\\shared', '--permission-mode', 'plan']);
});
