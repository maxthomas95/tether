import { describe, expect, it } from 'vitest';
import { extractErrorMessage, formatSessionExitMessage, sanitizeErrorMessage } from './errors';

describe('renderer error helpers', () => {
  it('strips Electron IPC wrapper text', () => {
    expect(extractErrorMessage(
      new Error("Error invoking remote method 'session:create': Error: Failed to spawn claude"),
    )).toBe('Failed to spawn claude');
  });

  it('redacts obvious secret assignments', () => {
    expect(sanitizeErrorMessage('request failed token=abc123 password: hunter2')).toBe(
      'request failed token=[redacted] password: [redacted]',
    );
  });

  it('includes transport detail in session exit messages', () => {
    expect(formatSessionExitMessage(1, 'SSH connection closed')).toBe(
      'Session exited with code 1.\nSSH connection closed',
    );
  });
});
