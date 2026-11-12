import { describe, expect, it, vi } from 'vitest';
import { codexPipStatus } from './codex';

const signal = new AbortController().signal;
function call(account: unknown, models: unknown, ok = true) {
  return vi.fn().mockResolvedValue([
    { method: 'account/read', ok, result: { account } },
    { method: 'model/list', ok, result: models },
  ]);
}

describe('Codex quip backend status', () => {
  it('reports the sign-in and the Luna model the quip would use', async () => {
    const lookup = call({ type: 'chatgpt', email: 'person@example.com' }, { data: [{ model: 'gpt-6-luna' }] });
    const status = await codexPipStatus(signal, lookup);
    expect(status).toEqual({ backend: 'codex', ready: true, detail: 'Signed in with ChatGPT. Quips use GPT-6 Luna.' });
    expect(JSON.stringify(status)).not.toContain('example.com');
    expect(lookup.mock.calls[0][0].map((row: { method: string }) => row.method)).toEqual(['account/read', 'model/list']);
  });

  it('explains an API-key sign-in, a missing Luna model, and an unreachable CLI', async () => {
    expect((await codexPipStatus(signal, call({ type: 'apiKey' }, { data: [{ model: 'gpt-6-luna' }] }))).detail).toContain('Sign in to Codex with ChatGPT');
    expect((await codexPipStatus(signal, call({ type: 'chatgpt' }, { data: [{ model: 'gpt-6' }] }))).detail).toContain('No Luna model');
    expect(await codexPipStatus(signal, call(null, null, false))).toMatchObject({ ready: false, detail: expect.stringContaining('Could not reach') });
    expect(await codexPipStatus(signal, vi.fn().mockRejectedValue(new Error('spawn failed')))).toMatchObject({ ready: false });
  });
});
