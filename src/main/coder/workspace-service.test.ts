import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '.',
  },
}));

vi.mock('../db/environment-repo', () => ({
  getEnvironment: vi.fn(),
}));

import { redactCoderCreateArgsForLog } from './workspace-service';

describe('workspace-service', () => {
  it('redacts coder create parameter values from log args', () => {
    expect(redactCoderCreateArgsForLog([
      'create',
      'ws',
      '--template',
      'tmpl',
      '--parameter',
      'api_key=secret-token',
      '--parameter',
      'size=large',
    ])).toEqual([
      'create',
      'ws',
      '--template',
      'tmpl',
      '--parameter',
      'api_key=[redacted]',
      '--parameter',
      'size=[redacted]',
    ]);
  });
});
