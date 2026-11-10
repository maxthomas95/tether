import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import {
  groupByWorkingDir, sessionsForEnvironment, sidebarSessionOrder, sortRepoGroupEntries, sortSessionsByPref,
} from './sidebar-order';

function session(id: string, workingDir: string, environmentId?: string, createdAt = id): SessionInfo {
  return { id, label: id, workingDir, environmentId: environmentId ?? null, state: 'running', createdAt } as SessionInfo;
}

const local = { id: 'env-local', type: 'local' as const };
const ssh = { id: 'env-ssh', type: 'ssh' as const };

describe('sidebar ordering', () => {
  it('lists sessions without an environment under the local one only', () => {
    const sessions = [session('a', '/repo'), session('b', '/repo', 'env-local'), session('c', '/repo', 'env-ssh')];
    expect(sessionsForEnvironment(local, sessions).map(s => s.id)).toEqual(['a', 'b']);
    expect(sessionsForEnvironment(ssh, sessions).map(s => s.id)).toEqual(['c']);
  });

  it('orders repo groups pinned first, then saved order, then path, without mutating the input', () => {
    const entries: [string, SessionInfo[]][] = [['/zeta', []], ['/alpha', []], ['/pinned', []], ['/ordered', []]];
    const sorted = sortRepoGroupEntries(entries, [
      { environmentId: 'env-local', workingDir: '/pinned', pinned: true, sortOrder: 5 },
      { environmentId: 'env-local', workingDir: '/ordered', pinned: false, sortOrder: 0 },
    ]);
    expect(sorted.map(entry => entry[0])).toEqual(['/pinned', '/ordered', '/alpha', '/zeta']);
    expect(entries.map(entry => entry[0])).toEqual(['/zeta', '/alpha', '/pinned', '/ordered']);
  });

  it('orders sessions by the saved order and sinks unsaved ones, oldest first', () => {
    const group = [session('new2', '/r', undefined, '2026-03'), session('x', '/r'), session('new1', '/r', undefined, '2026-02'), session('y', '/r')];
    const sorted = sortSessionsByPref({ environmentId: 'env-local', workingDir: '/r', orderedIds: ['y', 'x'] }, group);
    expect(sorted.map(s => s.id)).toEqual(['y', 'x', 'new1', 'new2']);
    expect(sortSessionsByPref(undefined, group)).toBe(group);
  });

  it('groups by working directory in first-seen order', () => {
    const grouped = groupByWorkingDir([session('a', '/one'), session('b', '/two'), session('c', '/one')]);
    expect(grouped.map(([dir, list]) => [dir, list.map(s => s.id)])).toEqual([['/one', ['a', 'c']], ['/two', ['b']]]);
  });

  it('flattens environments, repo groups and sessions in display order', () => {
    const sessions = [
      session('s1', '/b-repo'),
      session('s2', '/a-repo'),
      session('s3', '/b-repo'),
      session('r1', '/remote', 'env-ssh'),
      session('s4', '/c-repo', 'env-local'),
    ];
    const order = sidebarSessionOrder(
      [local, ssh],
      sessions,
      [{ environmentId: 'env-local', workingDir: '/c-repo', pinned: true, sortOrder: 0 }],
      [{ environmentId: 'env-local', workingDir: '/b-repo', orderedIds: ['s3', 's1'] }],
    );
    expect(order.map(s => s.id)).toEqual(['s4', 's2', 's3', 's1', 'r1']);
  });

  it('lists a session once even when two local environments would both claim it', () => {
    const order = sidebarSessionOrder([local, { id: 'env-local-2', type: 'local' }], [session('a', '/repo')], [], []);
    expect(order.map(s => s.id)).toEqual(['a']);
  });
});
