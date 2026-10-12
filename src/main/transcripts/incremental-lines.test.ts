import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HeadTailReader,
  MAX_VIEWER_ENTRIES,
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_TAIL_BYTES,
  capDigestEntries,
  cloneDigestState,
  createDigestState,
  nextLineStart,
  readCompleteLines,
  visibleDigestEntries,
  type DigestState,
} from './incremental-lines';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-lines-'));
  file = path.join(dir, 'f.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readCompleteLines', () => {
  it('hands over whole lines and reports the offset after the last newline', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthr');
    const chunks: string[] = [];
    const end = await readCompleteLines(file, 0, fs.statSync(file).size, t => chunks.push(t));
    expect(chunks.join('')).toBe('one\ntwo\n');
    expect(end).toBe(8);
  });

  it('continues from an offset and picks up a line completed later', async () => {
    fs.writeFileSync(file, 'one\ntwo\nthr');
    fs.appendFileSync(file, 'ee\n');
    const chunks: string[] = [];
    const end = await readCompleteLines(file, 8, fs.statSync(file).size, t => chunks.push(t));
    expect(chunks.join('')).toBe('three\n');
    expect(end).toBe(fs.statSync(file).size);
  });

  it('keeps multi-byte characters whole across read boundaries', async () => {
    const line = `${'é'.repeat(700_000)}\n`;
    fs.writeFileSync(file, line + line);
    let text = '';
    await readCompleteLines(file, 0, fs.statSync(file).size, t => { text += t; });
    expect(text).toBe(line + line);
  });

  it('throws on a missing file so callers can retry from the same offset', async () => {
    await expect(readCompleteLines(path.join(dir, 'nope'), 0, 10, () => {})).rejects.toThrow();
  });
});

describe('nextLineStart', () => {
  it('finds the start of the next whole line, or the end when there is none', async () => {
    fs.writeFileSync(file, 'abc\ndef\n');
    expect(await nextLineStart(file, 1, 8)).toBe(4);
    expect(await nextLineStart(file, 4, 8)).toBe(8);
    fs.writeFileSync(file, 'no newline at all');
    expect(await nextLineStart(file, 2, 17)).toBe(17);
  });
});

describe('digest state', () => {
  const text = (n: number) => ({ kind: 'text' as const, text: `t${n}` });

  it('clones deeply enough that folding into the copy leaves the original alone', () => {
    const state = createDigestState();
    const tool = { kind: 'tool' as const, name: 'shell', summary: 'ls' };
    state.entries.push(tool);
    state.toolEntries.set('c1', tool);
    const copy = cloneDigestState({ ...state, extra: 1 });
    copy.toolEntries.get('c1')!.failed = true;
    copy.entries.push(text(1));
    expect(tool).not.toHaveProperty('failed');
    expect(state.entries).toHaveLength(1);
    expect(copy.extra).toBe(1);
    expect(copy.entries[0]).toBe(copy.toolEntries.get('c1'));
  });

  it('caps the list while folding, keeps the newest, and forgets calls that fell off', () => {
    const state = createDigestState();
    const early = { kind: 'tool' as const, name: 'shell', summary: 'early' };
    state.entries.push(early);
    state.toolEntries.set('early', early);
    for (let i = 0; i < MAX_VIEWER_ENTRIES * 2; i++) state.entries.push(text(i));
    capDigestEntries(state);
    expect(state.entries).toHaveLength(MAX_VIEWER_ENTRIES);
    expect(state.dropped).toBe(true);
    expect(state.toolEntries.size).toBe(0);
    const before = state.entries;
    capDigestEntries(state);
    expect(state.entries).toBe(before);
  });

  it('shows at most the viewer cap and says when earlier activity is missing', () => {
    const state = createDigestState();
    for (let i = 0; i < MAX_VIEWER_ENTRIES + 5; i++) state.entries.push(text(i));
    const shown = visibleDigestEntries(state);
    expect(shown.entries).toHaveLength(MAX_VIEWER_ENTRIES);
    expect(shown.entries.at(-1)).toEqual(text(MAX_VIEWER_ENTRIES + 4));
    expect(shown.truncated).toBe(true);
    expect(visibleDigestEntries(createDigestState())).toEqual({ entries: [], truncated: false });
    const skipped = createDigestState();
    skipped.skippedMiddle = true;
    expect(visibleDigestEntries(skipped).truncated).toBe(true);
  });
});

describe('HeadTailReader', () => {
  interface WordState extends DigestState { lines: number }
  const reader = () => new HeadTailReader<WordState, { prompt: string | null; lines: number; truncated: boolean }>({
    create: () => ({ ...createDigestState(), lines: 0 }),
    fold(state, chunk) {
      for (const line of chunk.split('\n')) {
        if (!line) continue;
        state.lines++;
        if (state.prompt === null) state.prompt = line;
      }
    },
    finish: state => ({ prompt: state.prompt, lines: state.lines, truncated: visibleDigestEntries(state).truncated }),
  });

  it('returns null with no file attached or a missing one', async () => {
    const r = reader();
    expect(await r.refresh()).toBeNull();
    r.attach(path.join(dir, 'nope'));
    expect(await r.refresh()).toBeNull();
  });

  it('folds appended lines only, and a repeat refresh with nothing new changes nothing', async () => {
    fs.writeFileSync(file, 'task\na\n');
    const r = reader();
    r.attach(file);
    expect(await r.refresh()).toEqual({ prompt: 'task', lines: 2, truncated: false });
    expect(await r.refresh()).toEqual({ prompt: 'task', lines: 2, truncated: false });
    fs.appendFileSync(file, 'b\nc');
    expect((await r.refresh())?.lines).toBe(3);
    fs.appendFileSync(file, '\n');
    expect((await r.refresh())?.lines).toBe(4);
  });

  it('starts over when the file shrinks or another file is attached', async () => {
    fs.writeFileSync(file, 'old task\nx\ny\n');
    const r = reader();
    r.attach(file);
    await r.refresh();
    fs.writeFileSync(file, 'new\n');
    expect(await r.refresh()).toEqual({ prompt: 'new', lines: 1, truncated: false });
    const other = path.join(dir, 'g.jsonl');
    fs.writeFileSync(other, 'other\n');
    r.attach(other);
    expect((await r.refresh())?.prompt).toBe('other');
  });

  it('answers concurrent refreshes one after the other without folding anything twice', async () => {
    fs.writeFileSync(file, 'task\na\nb\n');
    const r = reader();
    r.attach(file);
    const results = await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    expect(results.map(x => x?.lines)).toEqual([3, 3, 3]);
  });

  it('reads the task from the head and the latest lines from the tail of a very long file', async () => {
    const filler = `${'x'.repeat(1023)}\n`.repeat(Math.ceil((TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES) / 1024) + 2048);
    fs.writeFileSync(file, `the task\n${filler}last line\n`);
    const r = reader();
    r.attach(file);
    const result = await r.refresh();
    expect(result?.prompt).toBe('the task');
    expect(result?.truncated).toBe(true);
    // Far fewer lines than the file holds: the middle was skipped.
    expect(result!.lines).toBeLessThan(Math.ceil(filler.length / 1024));
    fs.appendFileSync(file, 'appended\n');
    expect((await r.refresh())?.lines).toBe(result!.lines + 1);
  });
});
