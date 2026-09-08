import { describe, expect, it } from 'vitest';
import { getCodexLaunchSettings, readCodexLaunchFlags, updateCodexLaunchFlags } from './cli-tools';

describe('Codex launch flag helpers', () => {
  it('reads model, profile, and reasoning variants from stored flag entries', () => {
    expect(readCodexLaunchFlags([
      '--model gpt-5.1-codex',
      '-p work',
      '--config model_reasoning_effort=high',
    ])).toEqual({
      model: 'gpt-5.1-codex',
      profile: 'work',
      reasoningEffort: 'high',
    });
  });

  it('updates known Codex launch flags without changing unrelated flags', () => {
    const result = updateCodexLaunchFlags([
      '--search',
      '--model old-model',
      '-p old-profile',
      '-c model_reasoning_effort=low',
      '--no-alt-screen',
    ], {
      model: 'gpt-5.2-codex',
      profile: 'daily',
      reasoningEffort: 'high',
    });

    expect(result.conflict).toBeNull();
    expect(result.flags).toEqual([
      '--search',
      '--no-alt-screen',
      '--model=gpt-5.2-codex',
      '--profile=daily',
      '-c model_reasoning_effort=high',
    ]);
  });

  it('preserves manual config entries instead of rewriting around unrelated settings', () => {
    const flags = ['--search', '-c sandbox_mode=workspace-write'];
    const result = updateCodexLaunchFlags(flags, { reasoningEffort: 'medium' });

    expect(result.flags).toEqual(flags);
    expect(result.conflict).toContain('sandbox_mode=workspace-write');
  });

  it('rejects whitespace in guided launch values', () => {
    const result = updateCodexLaunchFlags([], { model: 'gpt 5' });

    expect(result.flags).toEqual([]);
    expect(result.conflict).toContain('Codex launch values');
  });

  it('returns safe effective launch metadata and omits unsafe values', () => {
    expect(getCodexLaunchSettings([
      '--model old-model',
      '--model=gpt-5.2-codex',
      '--profile bad profile',
      '-c model_reasoning_effort=medium',
    ])).toEqual({
      model: 'gpt-5.2-codex',
      reasoningEffort: 'medium',
    });
  });
});
