import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./database');

import {
  listSessions,
  getSessionRow,
  createSessionRow,
  updateSessionState,
  updateSessionLabel,
  deleteSessionRow,
  markAllRunningAsStopped,
} from './session-repo';
import { __resetDb } from './__mocks__/database';

describe('session-repo', () => {
  beforeEach(() => {
    __resetDb();
  });

  it('starts with no sessions', () => {
    expect(listSessions()).toHaveLength(0);
  });

  it('creates a session with correct defaults', () => {
    const session = createSessionRow({
      label: 'tether',
      working_dir: 'C:/repo/tether',
    });
    expect(session.label).toBe('tether');
    expect(session.working_dir).toBe('C:/repo/tether');
    expect(session.state).toBe('starting');
    expect(session.environment_id).toBeNull();
    expect(session.pid).toBeNull();
    expect(session.id).toBeTruthy();
  });

  it('creates a session with custom state and environment', () => {
    const session = createSessionRow({
      label: 'test',
      working_dir: '/tmp/test',
      state: 'running',
      environment_id: 'env-123',
    });
    expect(session.state).toBe('running');
    expect(session.environment_id).toBe('env-123');
  });

  it('lists sessions', () => {
    createSessionRow({ label: 's1', working_dir: '/a' });
    createSessionRow({ label: 's2', working_dir: '/b' });
    expect(listSessions()).toHaveLength(2);
  });

  it('gets a session by id', () => {
    const created = createSessionRow({ label: 'find-me', working_dir: '/tmp' });
    const found = getSessionRow(created.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe('find-me');
  });

  it('returns undefined for unknown id', () => {
    expect(getSessionRow('nonexistent')).toBeUndefined();
  });

  it('updates session state', () => {
    const session = createSessionRow({ label: 'test', working_dir: '/tmp' });
    updateSessionState(session.id, 'running');
    const updated = getSessionRow(session.id)!;
    expect(updated.state).toBe('running');
    expect(updated.last_active_at).toBeTruthy();
  });

  it('updates session label', () => {
    const session = createSessionRow({ label: 'old', working_dir: '/tmp' });
    updateSessionLabel(session.id, 'new');
    expect(getSessionRow(session.id)!.label).toBe('new');
  });

  it('deletes a session', () => {
    const session = createSessionRow({ label: 'delete-me', working_dir: '/tmp' });
    expect(listSessions()).toHaveLength(1);
    deleteSessionRow(session.id);
    expect(listSessions()).toHaveLength(0);
  });

  describe('markAllRunningAsStopped', () => {
    it('marks all active sessions as stopped', () => {
      const s1 = createSessionRow({ label: 's1', working_dir: '/a', state: 'running' });
      const s2 = createSessionRow({ label: 's2', working_dir: '/b', state: 'waiting' });
      const s3 = createSessionRow({ label: 's3', working_dir: '/c', state: 'idle' });
      const s4 = createSessionRow({ label: 's4', working_dir: '/d', state: 'starting' });

      markAllRunningAsStopped();

      expect(getSessionRow(s1.id)!.state).toBe('stopped');
      expect(getSessionRow(s2.id)!.state).toBe('stopped');
      expect(getSessionRow(s3.id)!.state).toBe('stopped');
      expect(getSessionRow(s4.id)!.state).toBe('stopped');
    });

    it('does not touch already-stopped or dead sessions', () => {
      const stopped = createSessionRow({ label: 'stopped', working_dir: '/a', state: 'stopped' });
      const dead = createSessionRow({ label: 'dead', working_dir: '/b', state: 'dead' });

      markAllRunningAsStopped();

      expect(getSessionRow(stopped.id)!.state).toBe('stopped');
      expect(getSessionRow(dead.id)!.state).toBe('dead');
    });

    it('clears pid on stopped sessions', () => {
      const session = createSessionRow({ label: 'test', working_dir: '/tmp', state: 'running' });
      // Manually set pid to simulate a running session
      getSessionRow(session.id)!.pid = 12345;

      markAllRunningAsStopped();

      expect(getSessionRow(session.id)!.pid).toBeNull();
    });
  });
});
