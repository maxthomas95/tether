import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { buildSessionRestartOptions } from './session-restart';

const dead: SessionInfo = {
  id: 'tether-id', environmentId: 'remote', workingDir: '/work', label: 'Conversation',
  state: 'dead', createdAt: '2026-10-01T00:00:00Z',
};

describe('session recovery identity', () => {
  it('prefers the current native id over a stale legacy alias and usage identity', () => {
    expect(buildSessionRestartOptions({ ...dead, toolSessionId: 'current', claudeSessionId: 'old',
      usageSessionId: 'remote:scoped-usage-id' }).resumeToolSessionId).toBe('current');
  });

  it('recovers legacy Claude sessions, including when the default tool is implicit', () => {
    expect(buildSessionRestartOptions({ ...dead, claudeSessionId: 'legacy' }).resumeToolSessionId).toBe('legacy');
  });

  it('does not mistake the Tether or usage identity for an uncaptured native id', () => {
    expect(buildSessionRestartOptions({ ...dead, cliTool: 'codex',
      usageSessionId: 'remote:scoped-usage-id' }).resumeToolSessionId).toBeUndefined();
  });

  it('does not send a Claude alias to another CLI or resume a custom binary', () => {
    expect(buildSessionRestartOptions({ ...dead, cliTool: 'codex', claudeSessionId: 'legacy' }).resumeToolSessionId).toBeUndefined();
    expect(buildSessionRestartOptions({ ...dead, cliTool: 'custom', toolSessionId: 'id' }).resumeToolSessionId).toBeUndefined();
  });

  it('carries the opaque launch snapshot id without exposing launch values', () => {
    expect(buildSessionRestartOptions({ ...dead, launchSnapshotId: 'snap-1' }).launchSnapshotId).toBe('snap-1');
  });
});
