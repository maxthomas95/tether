import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { parseCodexJsonl } from './codex-jsonl-parser';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-parse-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function tokenCountEvent(opts: {
  timestamp?: string;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  includeLast?: boolean;
  cumulative?: {
    input?: number;
    cached?: number;
    output?: number;
    reasoning?: number;
    total?: number;
  };
}): object {
  return {
    timestamp: opts.timestamp ?? '2026-05-09T03:28:10.172Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(opts.includeLast === false ? {} : {
          last_token_usage: {
            input_tokens: opts.input ?? 0,
            cached_input_tokens: opts.cached ?? 0,
            output_tokens: opts.output ?? 0,
            reasoning_output_tokens: opts.reasoning ?? 0,
            ...(opts.total !== undefined ? { total_tokens: opts.total } : {}),
          },
        }),
        ...(opts.cumulative ? {
          total_token_usage: {
            input_tokens: opts.cumulative.input ?? 0,
            cached_input_tokens: opts.cumulative.cached ?? 0,
            output_tokens: opts.cumulative.output ?? 0,
            reasoning_output_tokens: opts.cumulative.reasoning ?? 0,
            ...(opts.cumulative.total !== undefined ? { total_tokens: opts.cumulative.total } : {}),
          },
        } : {}),
      },
    },
  };
}

function turnContext(model: string, opts: { timestamp?: string; effort?: string; contextWindow?: number } = {}): object {
  return {
    type: 'turn_context',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    payload: {
      model,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.contextWindow ? { model_context_window: opts.contextWindow } : {}),
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseCodexJsonl', () => {
  it('attributes token deltas to the most recent turn_context model', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'sess', cwd: dir } },
      turnContext('gpt-5-codex'),
      tokenCountEvent({ input: 1000, cached: 200, output: 50, reasoning: 10 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].model).toBe('gpt-5-codex');
    expect(result.messages[0].inputTokens).toBe(800); // 1000 - 200 cached
    expect(result.messages[0].cacheReadTokens).toBe(200);
    expect(result.messages[0].outputTokens).toBe(50);
    expect(result.messages[0].reasoningTokens).toBe(10);
    expect(result.messages[0].cost).toBeGreaterThan(0);
    expect(result.currentModel).toBe('gpt-5-codex');
  });

  it('does not bill Codex reasoning tokens in addition to output tokens', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('unknown-model-for-default-pricing'),
      tokenCountEvent({ input: 1000, cached: 200, output: 50, reasoning: 10 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages[0].outputTokens).toBe(50);
    expect(result.messages[0].reasoningTokens).toBe(10);
    expect(result.messages[0].cost).toBeCloseTo(0.00321, 8);
  });

  it('captures current Codex reasoning and context metadata from turn_context', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5.6-sol', { effort: 'xhigh', contextWindow: 258400 }),
      tokenCountEvent({ input: 100, output: 10 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.currentModel).toBe('gpt-5.6-sol');
    expect(result.currentReasoningEffort).toBe('xhigh');
    expect(result.contextWindowTokens).toBe(258400);
    expect(result.contextUsedTokens).toBe(110);
    expect(result.observedAt).toBe('2026-05-09T03:28:10.172Z');
  });

  it('records valid metadata timestamps from turn_context and task_started events', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5.6-sol', { timestamp: '2026-05-09T01:00:00.000Z', effort: 'medium', contextWindow: 128000 }),
      {
        type: 'event_msg',
        timestamp: '2026-05-09T01:00:05.000Z',
        payload: { type: 'task_started', model_context_window: 258400 },
      },
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toEqual([]);
    expect(result.currentModel).toBe('gpt-5.6-sol');
    expect(result.currentReasoningEffort).toBe('medium');
    expect(result.contextWindowTokens).toBe(258400);
    expect(result.observedAt).toBe('2026-05-09T01:00:05.000Z');
  });

  it('supports cumulative-only token_count rows without changing last request context size', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({
        includeLast: false,
        cumulative: { input: 100, output: 10, total: 110 },
      }),
    ]);

    const result = parseCodexJsonl(file, {
      startOffset: 0,
      priorModel: null,
      priorContextUsedTokens: 42,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(result.contextUsedTokens).toBe(42);
    expect(result.tokenUsage).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110 });
  });

  it('dedupes repeated cumulative total_token_usage snapshots', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({
        input: 100,
        output: 10,
        cumulative: { input: 100, output: 10, total: 110 },
      }),
      tokenCountEvent({
        input: 100,
        output: 10,
        cumulative: { input: 100, output: 10, total: 110 },
      }),
      tokenCountEvent({
        input: 250,
        cached: 50,
        output: 25,
        reasoning: 5,
        cumulative: { input: 250, cached: 50, output: 25, reasoning: 5, total: 275 },
      }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(result.messages[1]).toMatchObject({ inputTokens: 100, cacheReadTokens: 50, outputTokens: 15, reasoningTokens: 5 });
    expect(result.contextUsedTokens).toBe(275);
    expect(result.tokenUsage).toMatchObject({ inputTokens: 250, cachedInputTokens: 50, outputTokens: 25, reasoningOutputTokens: 5, totalTokens: 275 });
  });

  it('dedupes a cumulative snapshot after restart when prior counters are supplied', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({
        input: 250,
        output: 25,
        reasoning: 5,
        cumulative: { input: 250, output: 25, reasoning: 5, total: 275 },
      }),
    ]);

    const first = parseCodexJsonl(file, { startOffset: 0, priorModel: null });
    fs.appendFileSync(file, JSON.stringify(tokenCountEvent({
      input: 250,
      output: 25,
      reasoning: 5,
      cumulative: { input: 250, output: 25, reasoning: 5, total: 275 },
    })) + '\n');

    const second = parseCodexJsonl(file, {
      startOffset: first.newByteOffset,
      priorModel: first.currentModel,
      priorTokenUsage: first.tokenUsage,
    });

    expect(second.messages).toEqual([]);
    expect(second.tokenUsage).toEqual(first.tokenUsage);
  });

  it('treats lower cumulative counters as a reset after truncation', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({
        input: 40,
        output: 4,
        cumulative: { input: 40, output: 4, total: 44 },
      }),
    ]);

    const result = parseCodexJsonl(file, {
      startOffset: 0,
      priorModel: null,
      priorTokenUsage: { inputTokens: 200, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 220 },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ inputTokens: 40, outputTokens: 4 });
  });

  it('rejects malformed token rows so corrupted counters cannot inflate cost or context', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify(turnContext('gpt-5-codex')),
      '{"timestamp":"2026-05-09T03:28:10.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":-1,"cached_input_tokens":null,"output_tokens":20,"reasoning_output_tokens":null}}}}',
      '{"timestamp":"2026-05-09T03:28:11.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10.5,"output_tokens":20}}}}',
      '{"timestamp":"2026-05-09T03:28:12.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":11,"output_tokens":20}}}}',
      '{"timestamp":"2026-05-09T03:28:13.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":20,"reasoning_output_tokens":21}}}}',
      '{"timestamp":"2026-05-09T03:28:14.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":20,"total_tokens":31}}}}',
      '{"timestamp":"2026-05-09T03:28:15.172Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":[]}}}',
    ].join('\n') + '\n');

    const result = parseCodexJsonl(file, {
      startOffset: 0,
      priorModel: null,
      priorContextUsedTokens: 99,
    });

    expect(result.messages).toEqual([]);
    expect(result.contextUsedTokens).toBe(99);
  });

  it('skips token_count rows with invalid timestamps instead of fabricating dated usage', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({ timestamp: 'not-a-date', input: 50, output: 5 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toEqual([]);
    expect(result.contextUsedTokens).toBeNull();
  });

  it('updates the active model when a new turn_context appears mid-file', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({ input: 100, output: 10 }),
      turnContext('gpt-5.5'),
      tokenCountEvent({ input: 200, output: 20 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages.map(m => m.model)).toEqual(['gpt-5-codex', 'gpt-5.5']);
    expect(result.currentModel).toBe('gpt-5.5');
  });

  it('uses priorModel when token_count appears before any turn_context in the chunk', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      tokenCountEvent({ input: 50, output: 5 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: 'gpt-5-codex' });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].model).toBe('gpt-5-codex');
  });

  it('falls back to "unknown" model when no priorModel and no turn_context yet', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      tokenCountEvent({ input: 50, output: 5 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].model).toBe('unknown');
  });

  it('skips empty token_count deltas (zeros)', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({}),
      tokenCountEvent({ input: 100, output: 10 }),
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });

    expect(result.messages).toHaveLength(1);
  });

  it('parses incrementally from a byte offset and advances it', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      turnContext('gpt-5-codex'),
      tokenCountEvent({ input: 100, output: 10 }),
    ]);
    const firstSize = fs.statSync(file).size;

    const first = parseCodexJsonl(file, { startOffset: 0, priorModel: null });
    expect(first.messages).toHaveLength(1);
    expect(first.newByteOffset).toBe(firstSize);

    fs.appendFileSync(file, JSON.stringify(tokenCountEvent({ input: 200, output: 20 })) + '\n');

    const second = parseCodexJsonl(file, {
      startOffset: first.newByteOffset,
      priorModel: first.currentModel,
    });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].inputTokens).toBe(200);
    expect(second.messages[0].model).toBe('gpt-5-codex');
    expect(second.newByteOffset).toBe(fs.statSync(file).size);
  });

  it('discards a partial trailing line and re-reads it on the next call', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    const completeLine = JSON.stringify(turnContext('gpt-5-codex')) + '\n'
      + JSON.stringify(tokenCountEvent({ input: 100, output: 10 })) + '\n';
    const partial = JSON.stringify(tokenCountEvent({ input: 200, output: 20 })).slice(0, 30);
    fs.writeFileSync(file, completeLine + partial);

    const first = parseCodexJsonl(file, { startOffset: 0, priorModel: null });
    expect(first.messages).toHaveLength(1);
    // Offset stops at the last newline so the partial line gets re-read.
    expect(first.newByteOffset).toBe(Buffer.byteLength(completeLine, 'utf-8'));

    fs.writeFileSync(file, completeLine + JSON.stringify(tokenCountEvent({ input: 200, output: 20 })) + '\n');

    const second = parseCodexJsonl(file, {
      startOffset: first.newByteOffset,
      priorModel: first.currentModel,
    });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].inputTokens).toBe(200);
  });

  it('returns no messages when file is missing', () => {
    const result = parseCodexJsonl(path.join(makeTempDir(), 'does-not-exist.jsonl'), {
      startOffset: 0,
      priorModel: null,
    });
    expect(result.messages).toEqual([]);
    expect(result.newByteOffset).toBe(0);
  });

  it('ignores non-event_msg, non-turn_context lines', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 's', cwd: dir } },
      { type: 'response_item', payload: { foo: 'bar' } },
      { type: 'function_call', payload: {} },
      turnContext('gpt-5-codex'),
      tokenCountEvent({ input: 100, output: 10 }),
      { type: 'event_msg', payload: { type: 'rate_limit_update', info: {} } },
    ]);

    const result = parseCodexJsonl(file, { startOffset: 0, priorModel: null });
    expect(result.messages).toHaveLength(1);
  });
});
