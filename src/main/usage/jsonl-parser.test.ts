import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonlFile } from './jsonl-parser';

let tmpDir = '';

function writeJsonl(lines: unknown[]): string {
  const file = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

describe('parseJsonlFile', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-jsonl-'));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats flat cache_creation_input_tokens as 5-minute cache creation', () => {
    const file = writeJsonl([{
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 7,
        },
      },
    }]);

    const result = parseJsonlFile(file, 0);
    expect(result.messages[0]).toMatchObject({
      cacheCreation5m: 100,
      cacheCreation1h: 0,
      cacheReadTokens: 7,
    });
  });

  it('keeps explicit 5-minute and 1-hour cache creation buckets separate', () => {
    const file = writeJsonl([{
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 25,
            ephemeral_1h_input_tokens: 50,
          },
        },
      },
    }]);

    const result = parseJsonlFile(file, 0);
    expect(result.messages[0]).toMatchObject({
      cacheCreation5m: 25,
      cacheCreation1h: 50,
    });
  });

  it('re-parses from zero when the stored offset is beyond the current file size', () => {
    const file = writeJsonl([{
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 1 },
      },
    }]);

    const result = parseJsonlFile(file, 10_000);
    expect(result.messages).toHaveLength(1);
    expect(result.newByteOffset).toBe(fs.statSync(file).size);
  });
});

