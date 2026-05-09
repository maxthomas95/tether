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
}): object {
  return {
    timestamp: opts.timestamp ?? '2026-05-09T03:28:10.172Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: opts.input ?? 0,
          cached_input_tokens: opts.cached ?? 0,
          output_tokens: opts.output ?? 0,
          reasoning_output_tokens: opts.reasoning ?? 0,
        },
      },
    },
  };
}

function turnContext(model: string): object {
  return { type: 'turn_context', payload: { model } };
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
    expect(result.messages[0].outputTokens).toBe(60); // 50 + 10 reasoning
    expect(result.messages[0].cost).toBeGreaterThan(0);
    expect(result.currentModel).toBe('gpt-5-codex');
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
