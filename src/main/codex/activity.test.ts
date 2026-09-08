import { describe, expect, it } from 'vitest';
import { MAX_CODEX_ACTIVE_SUBAGENTS, initialCodexSessionActivity, reduceCodexSessionActivity } from './activity';

describe('Codex activity reducer', () => {
  it('tracks phase, model, timestamp, and compactions', () => {
    let state = initialCodexSessionActivity();
    state = reduceCodexSessionActivity(state, 'permission_prompt', {
      model: 'gpt-5.4',
      at: '2026-09-07T00:00:00.000Z',
    });
    expect(state.phase).toBe('permission');
    expect(state.observedModel).toBe('gpt-5.4');
    expect(state.lastHookAt).toBe('2026-09-07T00:00:00.000Z');

    state = reduceCodexSessionActivity(state, 'compact_start', {});
    expect(state.phase).toBe('compacting');
    state = reduceCodexSessionActivity(state, 'compact_complete', {});
    expect(state.phase).toBe('running');
    expect(state.compactionCount).toBe(1);
  });

  it('deduplicates subagent starts and ignores duplicate stops', () => {
    let state = reduceCodexSessionActivity(undefined, 'subagent_start', { agentId: 'a1' });
    state = reduceCodexSessionActivity(state, 'subagent_start', { agentId: 'a1' });
    expect(state.activeSubagentIds).toEqual(['a1']);

    state = reduceCodexSessionActivity(state, 'subagent_stop', { agentId: 'a1' });
    state = reduceCodexSessionActivity(state, 'subagent_stop', { agentId: 'a1' });
    expect(state.activeSubagentIds).toEqual([]);
  });

  it('bounds active subagent ids', () => {
    let state = initialCodexSessionActivity();
    for (let i = 0; i < MAX_CODEX_ACTIVE_SUBAGENTS + 4; i++) {
      state = reduceCodexSessionActivity(state, 'subagent_start', { agentId: `agent-${i}` });
    }
    expect(state.activeSubagentIds).toHaveLength(MAX_CODEX_ACTIVE_SUBAGENTS);
    expect(state.activeSubagentIds[0]).toBe('agent-4');
  });

  it('does not let subagent bookkeeping override permission or complete phases', () => {
    let state = reduceCodexSessionActivity(undefined, 'permission_prompt', {});
    state = reduceCodexSessionActivity(state, 'subagent_start', { agentId: 'a1' });
    expect(state.phase).toBe('permission');
    expect(state.activeSubagentIds).toEqual(['a1']);

    state = reduceCodexSessionActivity(state, 'turn_complete', {});
    state = reduceCodexSessionActivity(state, 'subagent_stop', { agentId: 'a1' });
    expect(state.phase).toBe('complete');
    expect(state.activeSubagentIds).toEqual([]);
  });

  it('clears active subagents on terminal and interrupt events', () => {
    let state = reduceCodexSessionActivity(undefined, 'subagent_start', { agentId: 'a1' });
    state = reduceCodexSessionActivity(state, 'subagent_start', { agentId: 'a2' });
    state = reduceCodexSessionActivity(state, 'turn_interrupted', {});
    expect(state.phase).toBe('interrupted');
    expect(state.activeSubagentIds).toEqual([]);
  });

  it('suppresses duplicate compaction completion and stale events', () => {
    let state = reduceCodexSessionActivity(undefined, 'compact_start', {
      at: '2026-09-07T00:00:01.000Z',
    });
    state = reduceCodexSessionActivity(state, 'compact_complete', {
      at: '2026-09-07T00:00:02.000Z',
    });
    expect(state.compactionCount).toBe(1);

    const duplicate = reduceCodexSessionActivity(state, 'compact_complete', {
      at: '2026-09-07T00:00:03.000Z',
    });
    expect(duplicate).toBe(state);

    const stale = reduceCodexSessionActivity(state, 'permission_prompt', {
      at: '2026-09-07T00:00:01.500Z',
    });
    expect(stale).toBe(state);
  });

  it('tracks current and completed turn ids without dropping equal-timestamp subagent events', () => {
    let state = reduceCodexSessionActivity(undefined, 'turn_start', {
      turnId: 'turn-1',
      at: '2026-09-07T00:00:01.000Z',
    });
    expect(state.currentTurnId).toBe('turn-1');

    state = reduceCodexSessionActivity(state, 'subagent_start', {
      agentId: 'a1',
      at: '2026-09-07T00:00:01.000Z',
    });
    state = reduceCodexSessionActivity(state, 'subagent_start', {
      agentId: 'a2',
      at: '2026-09-07T00:00:01.000Z',
    });
    expect(state.activeSubagentIds).toEqual(['a1', 'a2']);

    state = reduceCodexSessionActivity(state, 'turn_complete', {
      turnId: 'turn-1',
      at: '2026-09-07T00:00:02.000Z',
    });
    expect(state.currentTurnId).toBeUndefined();
    expect(state.completedTurnIds).toEqual(['turn-1']);
  });
});
