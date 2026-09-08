import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseJsonlFile, type ParsedMessage } from './jsonl-parser';
import { parseCodexJsonl } from './codex-jsonl-parser';

vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

let directory: string | undefined;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-incremental-parsing-'));
  file = path.join(directory, 'fixture.jsonl');
  fs.writeFileSync(file, '');
});
afterEach(() => {
  if (directory) {
    fs.rmSync(path.join(directory, 'fixture.jsonl'), { force: true });
    fs.rmdirSync(directory);
    directory = undefined;
  }
});

const timestamp = '2026-09-07T12:00:00Z';
const text = 'Unicode: café 漢字 😀';
const fixtures = {
  claude: [
    { type: 'assistant', timestamp, message: { model: 'claude-sonnet-4', content: text, usage: { input_tokens: 20, output_tokens: 5 } } },
    { type: 'user', message: { content: text } },
    { type: 'assistant', timestamp, message: { model: 'claude-haiku-4-5', content: text, usage: { input_tokens: 30, output_tokens: 7 } } },
  ],
  codex: [
    { type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: text } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 5 } } } },
    { type: 'turn_context', payload: { model: 'gpt-5.5', cwd: text } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30, output_tokens: 7 } } } },
  ],
};

it.each([
  ['claude', 1], ['claude', 7], ['claude', 31],
  ['codex', 1], ['codex', 7], ['codex', 31],
] as const)('preserves %s usage across %i-byte transcript appends', (tool, chunkSize) => {
  const bytes = Buffer.from(fixtures[tool].map(record => JSON.stringify(record)).join('\n') + '\n');
  const parse = (offset: number, model: string | null) => tool === 'claude'
    ? { ...parseJsonlFile(file, offset), currentModel: null }
    : parseCodexJsonl(file, { startOffset: offset, priorModel: model });

  fs.writeFileSync(file, bytes);
  const expected = parse(0, null).messages;
  // Independently assert actual records; equality alone could accept two empty results.
  expect(expected).toHaveLength(2);
  expect(expected.map(message => [message.inputTokens, message.outputTokens])).toEqual([[20, 5], [30, 7]]);
  expect(expected.map(message => message.model)).toEqual(tool === 'claude'
    ? ['claude-sonnet-4', 'claude-haiku-4-5']
    : ['gpt-5-codex', 'gpt-5.5']);

  fs.writeFileSync(file, '');
  let offset = 0;
  let model: string | null = null;
  const messages: ParsedMessage[] = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = bytes.subarray(start, start + chunkSize);
    fs.appendFileSync(file, chunk);
    const result = parse(offset, model);
    expect(result.newByteOffset).toBeGreaterThanOrEqual(offset);
    expect(result.newByteOffset).toBeLessThanOrEqual(start + chunk.length);
    offset = result.newByteOffset;
    model = result.currentModel;
    messages.push(...result.messages);
  }
  expect(messages).toEqual(expected);
  expect(offset).toBe(bytes.length);
  // A refresh without another append must not count the same records again.
  expect(parse(offset, model).messages).toEqual([]);
});
