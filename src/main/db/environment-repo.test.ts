import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the database module so we don't need Electron
vi.mock('./database');

import {
  listEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  ensureDefaultLocalEnvironment,
} from './environment-repo';
import { __resetDb } from './__mocks__/database';

describe('environment-repo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no environments', () => {
    expect(listEnvironments()).toHaveLength(0);
  });

  it('creates an environment with correct defaults', () => {
    const env = createEnvironment({ name: 'Test', type: 'local' });
    expect(env.name).toBe('Test');
    expect(env.type).toBe('local');
    expect(env.config).toBe('{}');
    expect(env.env_vars).toBe('{}');
    expect(env.sort_order).toBe(0);
    expect(env.id).toBeTruthy();
    expect(env.created_at).toBeTruthy();
  });

  it('lists created environments', () => {
    createEnvironment({ name: 'Local', type: 'local' });
    createEnvironment({ name: 'SSH Box', type: 'ssh', config: { host: '10.0.0.1' } });
    const list = listEnvironments();
    expect(list).toHaveLength(2);
    expect(list.map(e => e.name)).toContain('Local');
    expect(list.map(e => e.name)).toContain('SSH Box');
  });

  it('stores config as JSON', () => {
    const env = createEnvironment({
      name: 'SSH',
      type: 'ssh',
      config: { host: '10.0.0.1', port: 22 },
    });
    const parsed = JSON.parse(env.config);
    expect(parsed.host).toBe('10.0.0.1');
    expect(parsed.port).toBe(22);
  });

  it('stores envVars as JSON', () => {
    const env = createEnvironment({
      name: 'WithVars',
      type: 'local',
      envVars: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    const parsed = JSON.parse(env.env_vars);
    expect(parsed.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('gets an environment by id', () => {
    const created = createEnvironment({ name: 'FindMe', type: 'local' });
    const found = getEnvironment(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('FindMe');
  });

  it('returns undefined for unknown id', () => {
    expect(getEnvironment('nonexistent')).toBeUndefined();
  });

  it('updates environment fields', () => {
    const env = createEnvironment({ name: 'Old', type: 'local' });
    vi.advanceTimersByTime(100); // ensure updated_at differs from created_at
    updateEnvironment(env.id, { name: 'New', type: 'ssh', config: { host: 'box' } });

    const updated = getEnvironment(env.id)!;
    expect(updated.name).toBe('New');
    expect(updated.type).toBe('ssh');
    expect(JSON.parse(updated.config).host).toBe('box');
    expect(updated.updated_at).not.toBe(env.created_at);
  });

  it('update is no-op for unknown id', () => {
    // Should not throw
    updateEnvironment('nonexistent', { name: 'whatever' });
  });

  it('deletes an environment', () => {
    const env = createEnvironment({ name: 'DeleteMe', type: 'local' });
    expect(listEnvironments()).toHaveLength(1);
    deleteEnvironment(env.id);
    expect(listEnvironments()).toHaveLength(0);
  });

  it('delete is no-op for unknown id', () => {
    createEnvironment({ name: 'Keep', type: 'local' });
    deleteEnvironment('nonexistent');
    expect(listEnvironments()).toHaveLength(1);
  });

  describe('ensureDefaultLocalEnvironment', () => {
    it('creates a Local environment if none exists', () => {
      const env = ensureDefaultLocalEnvironment();
      expect(env.name).toBe('Local');
      expect(env.type).toBe('local');
      expect(listEnvironments()).toHaveLength(1);
    });

    it('returns existing local environment if one exists', () => {
      const first = createEnvironment({ name: 'My Local', type: 'local' });
      const result = ensureDefaultLocalEnvironment();
      expect(result.id).toBe(first.id);
      expect(listEnvironments()).toHaveLength(1);
    });

    it('does not create a duplicate even when SSH environments exist', () => {
      createEnvironment({ name: 'SSH', type: 'ssh' });
      const local = ensureDefaultLocalEnvironment();
      expect(local.type).toBe('local');
      expect(listEnvironments()).toHaveLength(2);
    });
  });
});
