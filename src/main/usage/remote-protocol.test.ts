import { describe, expect, it } from 'vitest';
import { REMOTE_SUBAGENT_MAX_AGENTS, REMOTE_SUBAGENT_MAX_REPLY_TEXT, validateSubagentReply } from './remote-protocol';

const file = (over: Record<string, unknown> = {}) => ({
  id: 'a1', size: 10, mtimeMs: 5, birthMs: 1, offset: 10, text: '', metaMtimeMs: 0, ...over,
});
const list = (over: Record<string, unknown> = {}) => ({
  op: 'subagents', status: 'ready', found: true, agents: [file()], total: 1, more: false, now: 100, ...over,
});

describe('validateSubagentReply', () => {
  it('accepts a well-formed listing and transcript chunk', () => {
    expect(validateSubagentReply(list({ id: 3, project: 'p' }))).toMatchObject({ op: 'subagents', id: 3, project: 'p', total: 1 });
    expect(validateSubagentReply({ op: 'subagent-transcript', status: 'ready', found: true, text: '', offset: 0, size: 0, more: false }))
      .toMatchObject({ op: 'subagent-transcript', found: true });
  });

  it.each([
    ['a missing status', list({ status: undefined })],
    ['an unknown op', list({ op: 'other' })],
    ['too many agents', list({ agents: Array.from({ length: REMOTE_SUBAGENT_MAX_AGENTS + 1 }, (_, i) => file({ id: `a${i}` })) })],
    ['a path-like agent id', list({ agents: [file({ id: '../x' })] })],
    ['a duplicate agent id', list({ agents: [file(), file()] })],
    ['an offset past the file size', list({ agents: [file({ offset: 11 })] })],
    ['a negative size', list({ agents: [file({ size: -1, offset: 0 })] })],
    ['a fractional offset', list({ agents: [file({ offset: 1.5 })] })],
    ['non-string text', list({ agents: [file({ text: 5 })] })],
    ['a non-finite time', list({ agents: [file({ mtimeMs: Number.NaN })] })],
    ['a missing remote clock', list({ now: undefined })],
    ['an oversized project name', list({ project: 'x'.repeat(513) })],
    ['total payload over the cap', list({ agents: [file({ text: 'A'.repeat(REMOTE_SUBAGENT_MAX_REPLY_TEXT) }), file({ id: 'a2', text: 'A' })] })],
  ])('rejects %s', (_name, reply) => {
    expect(() => validateSubagentReply(reply)).toThrow('Invalid remote subagent reply');
  });

  it('rejects an oversized transcript chunk and a missing cursor', () => {
    const chunk = { op: 'subagent-transcript', status: 'ready', found: true, text: '', offset: 0, size: 0, more: false };
    expect(() => validateSubagentReply({ ...chunk, text: 'A'.repeat(REMOTE_SUBAGENT_MAX_REPLY_TEXT + 1) })).toThrow();
    expect(() => validateSubagentReply({ ...chunk, offset: undefined })).toThrow();
  });
});
