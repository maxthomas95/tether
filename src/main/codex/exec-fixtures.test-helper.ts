// Synthetic rollout lines for the codex exec tests. They
// follow the shape of the real files but carry no real content, ids or paths.

export const THREAD = '019aaaaa-0000-7000-8000-000000000001';
export const THREAD_2 = '019aaaaa-0000-7000-8000-000000000002';

export const at = (seconds: number, base = Date.UTC(2026, 0, 1, 12, 0, 0)): string =>
  new Date(base + seconds * 1000).toISOString();

export const jsonl = (...records: object[]): string => records.map(r => JSON.stringify(r)).join('\n') + '\n';

export const rolloutMeta = (seconds: number, opts: { id?: string; cwd?: string } = {}) => ({
  timestamp: at(seconds),
  type: 'session_meta',
  payload: {
    id: opts.id ?? THREAD,
    timestamp: at(seconds),
    cwd: opts.cwd ?? '/work/repo',
    originator: 'codex_exec',
    source: 'exec',
    cli_version: '0.0.0-test',
    model_provider: 'test-provider',
  },
});

export const turnContext = (seconds: number, model = 'test-model', effort = 'high') => ({
  timestamp: at(seconds), type: 'turn_context', payload: { model, effort },
});

export const userMessage = (seconds: number, message: string) => ({
  timestamp: at(seconds), type: 'event_msg', payload: { type: 'user_message', message },
});

export const taskStarted = (seconds: number) => ({
  timestamp: at(seconds), type: 'event_msg', payload: { type: 'task_started' },
});

export const taskComplete = (seconds: number, lastAgentMessage: string | null, type = 'task_complete') => ({
  timestamp: at(seconds), type: 'event_msg', payload: { type, last_agent_message: lastAgentMessage },
});

export const customToolCall = (seconds: number, callId: string, name: string, input: string) => ({
  timestamp: at(seconds), type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, input },
});

export const counters = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

export const tokenCount = (seconds: number, total: ReturnType<typeof counters>, last = total) => ({
  timestamp: at(seconds),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 } },
});

export const assistantText = (seconds: number, text: string) => ({
  timestamp: at(seconds),
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

export const injectedContext = (seconds: number) => ({
  timestamp: at(seconds),
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/repo</cwd>\n</environment_context>' }] },
});

export const userItem = (seconds: number, text: string) => ({
  timestamp: at(seconds),
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

export const functionCall = (seconds: number, callId: string, name: string, args: unknown) => ({
  timestamp: at(seconds),
  type: 'response_item',
  payload: { type: 'function_call', name, call_id: callId, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

export const functionOutput = (seconds: number, callId: string, output: unknown) => ({
  timestamp: at(seconds),
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output },
});

/** A whole short run: prompt, one tool call, an answer, usage and completion. */
export function sampleRollout(opts: { id?: string; cwd?: string; start?: number; prompt?: string; done?: boolean } = {}): string {
  const s = opts.start ?? 0;
  return jsonl(
    rolloutMeta(s, opts),
    taskStarted(s + 1),
    turnContext(s + 1),
    userMessage(s + 1, opts.prompt ?? 'Review the module and list risks.\nBe brief.'),
    functionCall(s + 2, 'call-1', 'shell', { command: ['bash', '-lc', 'ls src'] }),
    functionOutput(s + 3, 'call-1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nindex.ts'),
    tokenCount(s + 4, counters(1000, 200, 50, 10)),
    assistantText(s + 5, 'Two risks found.'),
    tokenCount(s + 6, counters(2000, 600, 120, 20), counters(1000, 400, 70, 10)),
    ...(opts.done === false ? [] : [taskComplete(s + 7, 'Two risks found.')]),
  );
}
