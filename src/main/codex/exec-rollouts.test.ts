import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexRolloutReader,
  CodexTranscriptReader,
  HOOK_STALE_MS,
  ROLLOUT_RUNNING_WINDOW_MS,
  createCodexExecScan,
  findRolloutByThreadId,
  foldCodexExecText,
  parseCodexExecTranscript,
  parseCodexRolloutMeta,
  rolloutThreadId,
  readRolloutHead,
  rolloutDayDirs,
  summarizeCodexArguments,
  toCodexExecChildInfo,
} from './exec-rollouts';
import {
  THREAD, THREAD_2, assistantText, at, counters, customToolCall, functionCall, functionOutput, injectedContext, jsonl,
  rolloutMeta, sampleRollout, taskComplete, taskStarted, tokenCount, turnContext, userItem, userMessage,
} from './exec-fixtures.test-helper';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('parseCodexRolloutMeta', () => {
  it('reads the thread id and the UTC start from the first session_meta', () => {
    expect(parseCodexRolloutMeta(jsonl(rolloutMeta(0)))).toEqual({ id: THREAD, startedAt: at(0) });
  });

  it('keeps the first header when a forked rollout repeats another one later', () => {
    expect(parseCodexRolloutMeta(jsonl(rolloutMeta(0), rolloutMeta(5, { id: THREAD_2 })))?.id).toBe(THREAD);
  });

  it('rejects a header without an id and tolerates junk around it', () => {
    expect(parseCodexRolloutMeta(jsonl({ type: 'session_meta', payload: { cwd: '/x' } }))).toBeNull();
    expect(parseCodexRolloutMeta('not json\n{"type":"session_meta"')).toBeNull();
    expect(parseCodexRolloutMeta(`junk\n${jsonl(rolloutMeta(0))}`)?.id).toBe(THREAD);
  });
});

describe('foldCodexExecText', () => {
  it('collects meta, prompt, model, effort, timing and tokens from a whole run', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, sampleRollout());
    expect(scan.meta?.id).toBe(THREAD);
    expect(scan.firstPrompt).toBe('Review the module and list risks.\nBe brief.');
    expect(scan.model).toBe('test-model');
    expect(scan.effort).toBe('high');
    expect(scan.startedAt).toBe(at(0));
    expect(scan.lastActivityAt).toBe(at(7));
    expect(scan.completed).toBe(true);
    // Cache reads are split out of input by the shared Codex usage parser.
    expect(scan.tokens).toEqual({ input: 1400, output: 120, cacheRead: 600, cacheWrite: 0 });
  });

  it('gives the same totals when the file is folded in pieces as when folded whole', () => {
    const whole = createCodexExecScan();
    foldCodexExecText(whole, sampleRollout());
    const parts = createCodexExecScan();
    const lines = sampleRollout().split('\n').filter(Boolean);
    foldCodexExecText(parts, lines.slice(0, 5).join('\n') + '\n');
    foldCodexExecText(parts, lines.slice(5, 8).join('\n') + '\n');
    foldCodexExecText(parts, lines.slice(8).join('\n') + '\n');
    expect(parts.tokens).toEqual(whole.tokens);
    expect(parts.model).toBe(whole.model);
    expect(parts.completed).toBe(true);
  });

  it('has no model or effort when the run has no turn_context yet, and still reads tokens', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, jsonl(rolloutMeta(0), userMessage(1, 'task'), tokenCount(2, counters(500, 0, 20))));
    expect(scan.model).toBeUndefined();
    expect(scan.effort).toBeUndefined();
    expect(scan.tokens).toEqual({ input: 500, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(scan.firstPrompt).toBe('task');
  });

  it('follows a model change on a later turn', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, jsonl(rolloutMeta(0), turnContext(1, 'model-a', 'low'), turnContext(9, 'model-b', 'high')));
    expect(scan.model).toBe('model-b');
    expect(scan.effort).toBe('high');
  });

  it('falls back to the first user response item that is not injected context for the prompt', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, jsonl(
      rolloutMeta(0),
      injectedContext(1),
      userItem(1, '# AGENTS.md instructions for /work/repo\n\n<INSTRUCTIONS>x</INSTRUCTIONS>'),
      userItem(2, 'the real task'),
    ));
    expect(scan.firstPrompt).toBe('the real task');
  });

  it('accepts the turn_complete and turn_started aliases for the completion and start events', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, jsonl(rolloutMeta(0), { timestamp: at(1), type: 'event_msg', payload: { type: 'turn_started' } }));
    expect(scan.completed).toBe(false);
    foldCodexExecText(scan, jsonl(taskComplete(2, 'done', 'turn_complete')));
    expect(scan.completed).toBe(true);
    foldCodexExecText(scan, jsonl({ timestamp: at(3), type: 'event_msg', payload: { type: 'turn_started' } }));
    expect(scan.completed).toBe(false);
  });

  it('is running again after a new turn starts and complete after it finishes', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, jsonl(rolloutMeta(0), taskStarted(1), taskComplete(2, 'a')));
    expect(scan.completed).toBe(true);
    foldCodexExecText(scan, jsonl(taskStarted(3)));
    expect(scan.completed).toBe(false);
  });

  it('skips malformed lines and unknown records', () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, `garbage\n{"type":"mystery"}\n{broken json\n${jsonl(rolloutMeta(0), turnContext(1))}`);
    expect(scan.meta?.id).toBe(THREAD);
    expect(scan.model).toBe('test-model');
  });
});

describe('parseCodexExecTranscript', () => {
  it('digests the prompt, tool calls, agent messages and the final message without tool output', () => {
    const parsed = parseCodexExecTranscript(sampleRollout());
    expect(parsed.prompt).toBe('Review the module and list risks.\nBe brief.');
    expect(parsed.entries).toEqual([{ kind: 'tool', name: 'shell', summary: 'ls src' }]);
    expect(parsed.result).toBe('Two risks found.');
    expect(JSON.stringify(parsed)).not.toContain('index.ts');
    expect(parsed.truncated).toBe(false);
  });

  it('keeps an agent message that is not the closing one, and marks failed tool calls', () => {
    const parsed = parseCodexExecTranscript(jsonl(
      rolloutMeta(0),
      userMessage(1, 'task'),
      assistantText(2, 'Looking at it.'),
      functionCall(3, 'c1', 'shell', { command: 'false' }),
      functionOutput(4, 'c1', JSON.stringify({ output: '', metadata: { exit_code: 1 } })),
      assistantText(5, 'Done.'),
      taskComplete(6, 'Done.'),
    ));
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'Looking at it.' },
      { kind: 'tool', name: 'shell', summary: 'false', failed: true },
    ]);
    expect(parsed.result).toBe('Done.');
  });

  it('uses the last agent message as the result when the run never completed cleanly', () => {
    const parsed = parseCodexExecTranscript(jsonl(rolloutMeta(0), userMessage(1, 'task'), assistantText(2, 'Partial answer.')));
    expect(parsed.result).toBe('Partial answer.');
    expect(parsed.entries).toEqual([]);
  });

  it('lists custom tool calls such as apply_patch, naming the file a patch touches', () => {
    const parsed = parseCodexExecTranscript(jsonl(
      rolloutMeta(0),
      userMessage(1, 'task'),
      customToolCall(2, 'p1', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch'),
      customToolCall(3, 'p2', 'other_tool', 'free text input'),
      functionOutput(4, 'p1', { content: 'bad', success: false }),
    ));
    expect(parsed.entries).toEqual([
      { kind: 'tool', name: 'apply_patch', summary: 'update src/a.ts', failed: true },
      { kind: 'tool', name: 'other_tool', summary: 'free text input' },
    ]);
  });

  it('reads the final message from a turn_complete event', () => {
    const parsed = parseCodexExecTranscript(jsonl(rolloutMeta(0), userMessage(1, 'task'), taskComplete(2, 'All done.', 'turn_complete')));
    expect(parsed.result).toBe('All done.');
  });

  it('is empty rather than throwing on an empty or unreadable file', () => {
    expect(parseCodexExecTranscript('')).toEqual({ prompt: null, entries: [], result: null, truncated: false });
    expect(parseCodexExecTranscript('not json at all\n').entries).toEqual([]);
  });

  it('keeps only the most recent entries when a run is very long', () => {
    const calls = Array.from({ length: 900 }, (_, i) => functionCall(i, `c${i}`, 'shell', { command: `echo ${i}` }));
    const parsed = parseCodexExecTranscript(jsonl(rolloutMeta(0), userMessage(1, 'task'), ...calls));
    expect(parsed.entries).toHaveLength(400);
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries.at(-1)).toMatchObject({ summary: 'echo 899' });
  });
});

describe('summarizeCodexArguments', () => {
  it('unwraps shell argv, cmd strings and path-like keys to one line', () => {
    expect(summarizeCodexArguments(JSON.stringify({ command: ['bash', '-lc', 'git status\n--short'] }))).toBe('git status --short');
    expect(summarizeCodexArguments({ cmd: 'ls -la' })).toBe('ls -la');
    expect(summarizeCodexArguments(JSON.stringify({ path: 'a/b.ts', other: 1 }))).toBe('a/b.ts');
    expect(summarizeCodexArguments('plain text')).toBe('plain text');
    expect(summarizeCodexArguments(42)).toBe('');
  });
});

describe('toCodexExecChildInfo', () => {
  const finished = () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, sampleRollout());
    return scan;
  };
  const running = () => {
    const scan = createCodexExecScan();
    foldCodexExecText(scan, sampleRollout({ done: false }));
    return scan;
  };

  it('describes a finished run from its rollout', () => {
    const info = toCodexExecChildInfo({
      threadId: THREAD, scan: finished(), rolloutMtimeMs: BASE + 7000, hook: null, nowMs: BASE + 8000, alive: true,
    });
    expect(info).toMatchObject({
      source: 'codex-exec', id: THREAD, agentType: 'codex exec', description: 'Review the module and list risks.',
      model: 'test-model', effort: 'high', depth: 1, state: 'done',
      startedAt: at(0), lastActivityAt: at(7),
      tokens: { input: 1400, output: 120, cacheRead: 600, cacheWrite: 0 },
    });
  });

  it('without hooks, is running only while the rollout is unfinished and recently written', () => {
    const base = { threadId: THREAD, scan: running(), hook: null, alive: true };
    expect(toCodexExecChildInfo({ ...base, rolloutMtimeMs: BASE, nowMs: BASE + ROLLOUT_RUNNING_WINDOW_MS }).state).toBe('running');
    expect(toCodexExecChildInfo({ ...base, rolloutMtimeMs: BASE, nowMs: BASE + ROLLOUT_RUNNING_WINDOW_MS + 1 }).state).toBe('done');
  });

  it('with hooks, follows the last hook and goes quiet-stale after the stale window', () => {
    const hook = (state: 'running' | 'done') => ({ state, firstAtMs: BASE, lastAtMs: BASE + 1000, model: 'hook-model' });
    const base = { threadId: THREAD, scan: null, rolloutMtimeMs: null, alive: true };
    expect(toCodexExecChildInfo({ ...base, hook: hook('running'), nowMs: BASE + 5000 }).state).toBe('running');
    expect(toCodexExecChildInfo({ ...base, hook: hook('done'), nowMs: BASE + 5000 }).state).toBe('done');
    expect(toCodexExecChildInfo({ ...base, hook: hook('running'), nowMs: BASE + 1000 + HOOK_STALE_MS + 1 }).state).toBe('done');
  });

  it('shows the model from hook metadata when there is no rollout (an ephemeral run)', () => {
    const info = toCodexExecChildInfo({
      threadId: THREAD, scan: null, rolloutMtimeMs: null, nowMs: BASE + 2000, alive: true,
      hook: { state: 'running', firstAtMs: BASE, lastAtMs: BASE + 1000, model: 'hook-model' },
    });
    expect(info).toMatchObject({ model: 'hook-model', description: '', state: 'running', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(info.effort).toBeUndefined();
  });

  it('treats a rollout that finished after the last hook as done even if the Stop hook never came', () => {
    const info = toCodexExecChildInfo({
      threadId: THREAD, scan: finished(), rolloutMtimeMs: BASE + 7000, nowMs: BASE + 8000, alive: true,
      hook: { state: 'running', firstAtMs: BASE, lastAtMs: BASE + 3000 },
    });
    expect(info.state).toBe('done');
  });

  it('never reports a run as running once the Claude session is gone', () => {
    const info = toCodexExecChildInfo({
      threadId: THREAD, scan: null, rolloutMtimeMs: null, nowMs: BASE + 2000, alive: false,
      hook: { state: 'running', firstAtMs: BASE, lastAtMs: BASE + 1000 },
    });
    expect(info.state).toBe('done');
  });
});

describe('rollout file names and day folders', () => {
  it('reads the exact thread id out of a rollout name and nothing else', () => {
    expect(rolloutThreadId(`rollout-2026-01-01T12-00-05-${THREAD}.jsonl`)).toBe(THREAD);
    expect(rolloutThreadId('history.jsonl')).toBeNull();
    expect(rolloutThreadId(`rollout-2026-01-01T12-00-05-${THREAD}.jsonl.bak`)).toBeNull();
    expect(rolloutThreadId(`x-rollout-2026-01-01T12-00-05-${THREAD}.jsonl`)).toBeNull();
  });

  it('lists the day folders from one day past now back to the window start, across month ends', () => {
    const now = new Date(2026, 2, 1, 0, 30).getTime();
    const from = new Date(2026, 1, 27, 23, 0).getTime();
    const dirs = rolloutDayDirs('/home', from, now).map(d => d.split(path.sep).slice(-3).join('/'));
    expect(dirs).toEqual(['2026/03/02', '2026/03/01', '2026/02/28', '2026/02/27']);
  });
});

describe('rollout files on disk', () => {
  let home: string;
  const dayDir = (d: Date) => path.join(
    home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'),
  );
  const nameFor = (d: Date, id: string) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `rollout-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${id}.jsonl`;
  };
  function writeRollout(when: Date, id: string, body: string): string {
    const dir = dayDir(when);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, nameFor(when, id));
    fs.writeFileSync(file, body);
    return file;
  }

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-rollouts-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const find = (id: string, since: Date, now: Date) => findRolloutByThreadId(id, home, since.getTime(), now.getTime());

  it('finds a rollout by exact thread id, including one that started the day before now', async () => {
    const now = new Date(2026, 5, 10, 0, 5, 0);
    const started = new Date(2026, 5, 9, 23, 58, 0);
    const file = writeRollout(started, THREAD, sampleRollout());
    expect(await find(THREAD, started, now)).toBe(file);
    expect(await find(THREAD_2, started, now)).toBeNull();
  });

  it('finds a run that spans midnight from where its hooks first reported', async () => {
    const started = new Date(2026, 5, 9, 23, 58, 0);
    const file = writeRollout(started, THREAD, sampleRollout());
    expect(await find(THREAD, started, new Date(2026, 5, 10, 6, 0, 0))).toBe(file);
  });

  it('allows a day of skew either side of the hook time for a name dated off the UTC start', async () => {
    const hookTime = new Date(2026, 5, 10, 12, 0, 0);
    const before = writeRollout(new Date(2026, 5, 9, 18, 0, 0), THREAD, sampleRollout());
    const after = writeRollout(new Date(2026, 5, 11, 1, 0, 0), THREAD_2, sampleRollout({ id: THREAD_2 }));
    expect(await find(THREAD, hookTime, hookTime)).toBe(before);
    expect(await find(THREAD_2, hookTime, hookTime)).toBe(after);
  });

  it('does not look further back than a day before the hooks first reported', async () => {
    writeRollout(new Date(2026, 5, 1, 9, 0, 0), THREAD, sampleRollout());
    const hookTime = new Date(2026, 5, 10, 12, 0, 0);
    expect(await find(THREAD, hookTime, hookTime)).toBeNull();
  });

  it('refuses ids that are not plain ids', async () => {
    const now = new Date(2026, 5, 10, 12, 0, 0);
    expect(await find('../../etc', now, now)).toBeNull();
  });

  it('rejects a file named for the thread whose own session_meta id is a different thread', async () => {
    const when = new Date(2026, 5, 10, 12, 0, 0);
    writeRollout(when, THREAD, sampleRollout({ id: THREAD_2 }));
    expect(await find(THREAD, when, when)).toBeNull();
  });

  it('does not take a rollout whose header is not written yet, so the caller retries', async () => {
    const when = new Date(2026, 5, 10, 12, 0, 0);
    writeRollout(when, THREAD, '{"timestamp":"2026-01-01T12:00:00.000Z","type":"session_me');
    expect(await find(THREAD, when, when)).toBeNull();
  });

  it('reads meta from the head of a rollout', async () => {
    const when = new Date(2026, 5, 10, 12, 0, 0);
    const file = writeRollout(when, THREAD, sampleRollout());
    expect((await readRolloutHead(file))?.id).toBe(THREAD);
  });

  it('has no meta for a rollout whose first line is not finished yet or that is missing', async () => {
    const when = new Date(2026, 5, 10, 12, 0, 0);
    const file = writeRollout(when, THREAD, '{"timestamp":"2026-01-01T12:00:00.000Z","type":"session_me');
    expect(await readRolloutHead(file)).toBeNull();
    expect(await readRolloutHead(path.join(home, 'missing.jsonl'))).toBeNull();
  });

  it('reads only appended bytes, holds back a partial line, and restarts if the file shrinks', async () => {
    const file = path.join(home, 'run.jsonl');
    const lines = sampleRollout({ done: false });
    const cut = lines.indexOf('"token_count"');
    fs.writeFileSync(file, lines.slice(0, cut));
    const reader = new CodexRolloutReader(file);
    expect(await reader.refresh()).toBe(true);
    // The line holding the first token_count is incomplete, so no tokens yet.
    expect(reader.scan.tokens.input).toBe(0);
    fs.writeFileSync(file, lines);
    await reader.refresh();
    expect(reader.scan.tokens).toEqual({ input: 1400, output: 120, cacheRead: 600, cacheWrite: 0 });
    await reader.refresh();
    expect(reader.scan.tokens.input).toBe(1400);
    fs.writeFileSync(file, jsonl(rolloutMeta(0, { id: THREAD_2 })));
    await reader.refresh();
    expect(reader.scan.meta?.id).toBe(THREAD_2);
    expect(reader.scan.tokens.input).toBe(0);
  });

  it('reports a rollout that does not exist (an ephemeral run) instead of throwing', async () => {
    expect(await new CodexRolloutReader(path.join(home, 'none.jsonl')).refresh()).toBe(false);
  });
});

describe('CodexTranscriptReader (the viewer)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-viewer-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses only what was appended, and returns the same digest when nothing changed', async () => {
    const file = path.join(dir, 'run.jsonl');
    fs.writeFileSync(file, jsonl(rolloutMeta(0), userMessage(1, 'task'), functionCall(2, 'c1', 'shell', { command: 'ls' })));
    const reader = new CodexTranscriptReader();
    reader.attach(file);
    const first = await reader.refresh();
    expect(first?.entries).toEqual([{ kind: 'tool', name: 'shell', summary: 'ls' }]);
    expect(await reader.refresh()).toEqual(first);

    fs.appendFileSync(file, jsonl(functionOutput(3, 'c1', 'Exit code: 2\nOutput:\nx'), assistantText(4, 'Done.'), taskComplete(5, 'Done.')));
    const second = await reader.refresh();
    expect(second?.entries).toEqual([{ kind: 'tool', name: 'shell', summary: 'ls', failed: true }]);
    expect(second?.result).toBe('Done.');
    // The earlier snapshot is not mutated by later reads.
    expect(first?.entries[0]).not.toHaveProperty('failed');
  });

  it('gives the same digest whether the file is folded whole or in pieces', async () => {
    const body = sampleRollout();
    const file = path.join(dir, 'run.jsonl');
    const lines = body.split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
    const reader = new CodexTranscriptReader();
    reader.attach(file);
    await reader.refresh();
    fs.writeFileSync(file, body);
    expect(await reader.refresh()).toEqual(parseCodexExecTranscript(body));
  });

  it('holds back a partial last line until it is complete', async () => {
    const file = path.join(dir, 'run.jsonl');
    const whole = jsonl(rolloutMeta(0), userMessage(1, 'task'), assistantText(2, 'Half.'));
    fs.writeFileSync(file, whole.slice(0, -10));
    const reader = new CodexTranscriptReader();
    reader.attach(file);
    expect((await reader.refresh())?.result).toBeNull();
    fs.writeFileSync(file, whole);
    expect((await reader.refresh())?.result).toBe('Half.');
  });

  it('starts over when the file is replaced by a shorter one, and reports a missing file as null', async () => {
    const file = path.join(dir, 'run.jsonl');
    fs.writeFileSync(file, sampleRollout());
    const reader = new CodexTranscriptReader();
    reader.attach(file);
    await reader.refresh();
    fs.writeFileSync(file, jsonl(userMessage(1, 'new task')));
    expect((await reader.refresh())?.prompt).toBe('new task');
    fs.rmSync(file);
    expect(await reader.refresh()).toBeNull();
  });

  it('reads the task from the head and the latest work from the tail of a very long rollout', async () => {
    const file = path.join(dir, 'big.jsonl');
    const filler = jsonl(assistantText(1, 'x'.repeat(3900))).repeat(2400);
    expect(filler.length).toBeGreaterThan(9 * 1024 * 1024);
    fs.writeFileSync(file, jsonl(rolloutMeta(0), userMessage(1, 'the original task')) + filler
      + jsonl(functionCall(9, 'late', 'shell', { command: 'echo late' }), assistantText(10, 'The answer.'), taskComplete(11, 'The answer.')));
    const reader = new CodexTranscriptReader();
    reader.attach(file);
    const parsed = await reader.refresh();
    expect(parsed?.prompt).toBe('the original task');
    expect(parsed?.result).toBe('The answer.');
    expect(parsed?.entries.some(e => e.kind === 'tool' && e.summary === 'echo late')).toBe(true);
    expect(parsed?.truncated).toBe(true);
    expect(parsed?.entries.length).toBeLessThanOrEqual(400);
  });
});
