import { describe, expect, it } from 'vitest';
import {
  matchFields,
  searchSessions,
  FIELD_WEIGHTS,
  type SearchableSession,
  type NamedSearchField,
} from './session-search';

function mkSession(over: Partial<SearchableSession> & { id: string }): SearchableSession {
  return {
    label: '',
    workingDir: '',
    environmentName: '',
    cliToolId: 'claude',
    ...over,
  };
}

function fields(parts: Array<[string, string, number]>): NamedSearchField[] {
  return parts.map(([key, text, weight]) => ({ key, text, weight }));
}

describe('matchFields', () => {
  it('matches an empty query against everything with a neutral score', () => {
    const r = matchFields('', fields([['label', 'anything', 1]]));
    expect(r.matched).toBe(true);
    expect(r.score).toBe(0);
  });

  it('treats a whitespace-only query as empty', () => {
    const r = matchFields('   ', fields([['label', 'anything', 1]]));
    expect(r.matched).toBe(true);
    expect(r.score).toBe(0);
  });

  it('matches a contiguous substring', () => {
    const r = matchFields('api', fields([['label', 'api-server', 1]]));
    expect(r.matched).toBe(true);
    expect(r.fields[0].ranges).toEqual([[0, 3]]);
  });

  it('matches a scattered subsequence', () => {
    const r = matchFields('apsv', fields([['label', 'api-server', 1]]));
    expect(r.matched).toBe(true);
  });

  it('does not match when the query is not a subsequence', () => {
    const r = matchFields('xyz', fields([['label', 'api-server', 1]]));
    expect(r.matched).toBe(false);
    expect(r.score).toBe(0);
  });

  it('is case-insensitive', () => {
    const r = matchFields('API', fields([['label', 'api-server', 1]]));
    expect(r.matched).toBe(true);
  });

  it('scores a contiguous match higher than a scattered one', () => {
    const contiguous = matchFields('abc', fields([['label', 'abcxyz', 1]]));
    const scattered = matchFields('abc', fields([['label', 'axbxcx', 1]]));
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  it('scores a start-anchored match higher than a mid-string match', () => {
    const anchored = matchFields('srv', fields([['label', 'srvfoo', 1]]));
    const mid = matchFields('srv', fields([['label', 'foosrv', 1]]));
    expect(anchored.score).toBeGreaterThan(mid.score);
  });

  it('rewards a word-boundary match (after a separator)', () => {
    const boundary = matchFields('s', fields([['label', 'api-server', 1]]));
    const nonBoundary = matchFields('p', fields([['label', 'api-server', 1]]));
    // 's' begins a word (after '-'), 'p' is mid-word in "api".
    expect(boundary.score).toBeGreaterThan(nonBoundary.score);
  });

  it('rewards higher density (filling more of a shorter field)', () => {
    const dense = matchFields('abc', fields([['label', 'abc', 1]]));
    const sparse = matchFields('abc', fields([['label', 'abc-very-long-suffix', 1]]));
    expect(dense.score).toBeGreaterThan(sparse.score);
  });

  it('prefers a label hit over a dir hit at equal text', () => {
    const labelHit = matchFields('foo', fields([
      ['label', 'foo', FIELD_WEIGHTS.label],
      ['dir', 'unrelated', FIELD_WEIGHTS.dir],
    ]));
    const dirHit = matchFields('foo', fields([
      ['label', 'unrelated', FIELD_WEIGHTS.label],
      ['dir', 'foo', FIELD_WEIGHTS.dir],
    ]));
    expect(labelHit.score).toBeGreaterThan(dirHit.score);
  });

  it('reports matched ranges only for fields that matched', () => {
    const r = matchFields('foo', fields([
      ['label', 'foobar', FIELD_WEIGHTS.label],
      ['dir', 'nope', FIELD_WEIGHTS.dir],
    ]));
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].key).toBe('label');
  });

  it('treats regex metacharacters as literal characters', () => {
    // A query full of regex specials must not throw or be interpreted — it
    // simply fails to be a subsequence of a plain label.
    const r = matchFields('.*+?', fields([['label', 'api-server', 1]]));
    expect(r.matched).toBe(false);
    // And it DOES match when those literals are actually present, in order.
    const r2 = matchFields('a.b', fields([['label', 'a.b.c', 1]]));
    expect(r2.matched).toBe(true);
  });
});

describe('searchSessions', () => {
  const sessions: SearchableSession[] = [
    mkSession({ id: '1', label: 'api server', workingDir: '/home/me/api', environmentName: 'Local', cliToolId: 'claude' }),
    mkSession({ id: '2', label: 'web client', workingDir: '/home/me/web', environmentName: 'Linux VM', cliToolId: 'codex' }),
    mkSession({ id: '3', label: 'docs', workingDir: '/home/me/api/docs', environmentName: 'Local', cliToolId: 'claude' }),
  ];

  it('returns all sessions in original order for an empty query', () => {
    const hits = searchSessions('', sessions);
    expect(hits.map(h => h.session.id)).toEqual(['1', '2', '3']);
  });

  it('filters to only matching sessions', () => {
    const hits = searchSessions('web', sessions);
    expect(hits.map(h => h.session.id)).toEqual(['2']);
  });

  it('ranks a label match above a directory-only match', () => {
    // "api" hits session 1's label and session 3's dir. Label should win.
    const hits = searchSessions('api', sessions);
    expect(hits[0].session.id).toBe('1');
    expect(hits.map(h => h.session.id)).toContain('3');
  });

  it('matches against the environment name', () => {
    const hits = searchSessions('vm', sessions);
    expect(hits.map(h => h.session.id)).toEqual(['2']);
  });

  it('matches against the CLI tool id', () => {
    const hits = searchSessions('codex', sessions);
    expect(hits.map(h => h.session.id)).toEqual(['2']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(searchSessions('zzzz', sessions)).toEqual([]);
  });

  it('is stable: equal scores preserve original order', () => {
    const dupes: SearchableSession[] = [
      mkSession({ id: 'a', label: 'same' }),
      mkSession({ id: 'b', label: 'same' }),
      mkSession({ id: 'c', label: 'same' }),
    ];
    const hits = searchSessions('same', dupes);
    expect(hits.map(h => h.session.id)).toEqual(['a', 'b', 'c']);
  });

  it('carries the original session object through on the hit', () => {
    const hits = searchSessions('docs', sessions);
    expect(hits[0].session.workingDir).toBe('/home/me/api/docs');
  });
});
