import fs from 'node:fs';
import type { ChildTranscriptEntry } from '../../shared/child-agents';

/**
 * Incremental reading shared by the Claude subagent and Codex rollout readers:
 * complete JSONL lines are folded by byte offset (a trailing partial line is
 * held back), and the viewer's digest is built from a long file's head plus its
 * tail, then only from appended bytes.
 */

const READ_CHUNK_BYTES = 1024 * 1024;
/** A line this long with no newline is not a transcript record. */
const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024;
/** Viewer reads the start of a long transcript (the task) and its tail (the latest work). */
export const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
export const MAX_VIEWER_ENTRIES = 400;

/**
 * Feed the complete lines found in bytes [from, size) of `file` to `onText`,
 * holding back a trailing partial line. Returns the offset after the last
 * complete line, which is where the next read should start. Throws on any I/O
 * error, so callers fold into a scratch copy and commit only on success.
 */
export async function readCompleteLines(file: string, from: number, size: number, onText: (text: string) => void): Promise<number> {
  const handle = await fs.promises.open(file, 'r');
  try {
    let pos = from;
    let carry: Buffer = Buffer.alloc(0);
    while (pos + carry.length < size) {
      const want = Math.min(READ_CHUNK_BYTES, size - pos - carry.length);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buf, 0, want, pos + carry.length);
      if (bytesRead === 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const newline = data.lastIndexOf(0x0a);
      if (newline === -1) {
        carry = Buffer.from(data);
        if (carry.length > MAX_PENDING_LINE_BYTES) {
          pos += carry.length;
          carry = Buffer.alloc(0);
        }
        continue;
      }
      onText(data.subarray(0, newline + 1).toString('utf8'));
      pos += newline + 1;
      carry = Buffer.from(data.subarray(newline + 1));
    }
    return pos;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Offset just after the first newline at or beyond `from`, or `size` if there is none. */
export async function nextLineStart(file: string, from: number, size: number): Promise<number> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = from;
    while (pos < size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead === 0) break;
      const newline = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) return pos + newline + 1;
      pos += bytesRead;
    }
    return size;
  } finally {
    await handle.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Viewer digest state
// ---------------------------------------------------------------------------

export type ToolEntry = Extract<ChildTranscriptEntry, { kind: 'tool' }>;

/** What a viewer digest accumulates line by line, so a file can be read in pieces. */
export interface DigestState {
  prompt: string | null;
  entries: ChildTranscriptEntry[];
  toolEntries: Map<string, ToolEntry>;
  dropped: boolean;
  skippedMiddle: boolean;
}

export function createDigestState(): DigestState {
  return { prompt: null, entries: [], toolEntries: new Map(), dropped: false, skippedMiddle: false };
}

/** A deep enough copy that folding into it leaves the original untouched. */
export function cloneDigestState<S extends DigestState>(state: S): S {
  const copies = new Map<ChildTranscriptEntry, ChildTranscriptEntry>();
  const entries = state.entries.map(e => { const copy = { ...e }; copies.set(e, copy); return copy; });
  const toolEntries = new Map<string, ToolEntry>();
  for (const [id, tool] of state.toolEntries) toolEntries.set(id, (copies.get(tool) ?? { ...tool }) as ToolEntry);
  return { ...state, entries, toolEntries };
}

/** Keep the entry list bounded while folding: past twice the viewer cap, drop all but the newest. */
export function capDigestEntries(state: DigestState): void {
  if (state.entries.length <= MAX_VIEWER_ENTRIES * 2) return;
  state.entries = state.entries.slice(-MAX_VIEWER_ENTRIES);
  state.dropped = true;
  // A late result can only matter for a call that is still listed.
  const listed = new Set(state.entries);
  for (const [id, tool] of state.toolEntries) if (!listed.has(tool)) state.toolEntries.delete(id);
}

/** The entries the viewer shows (a copy), and whether earlier activity is missing. */
export function visibleDigestEntries(state: DigestState): { entries: ChildTranscriptEntry[]; truncated: boolean } {
  const truncated = state.dropped || state.skippedMiddle || state.entries.length > MAX_VIEWER_ENTRIES;
  return { entries: state.entries.slice(-MAX_VIEWER_ENTRIES), truncated };
}

// ---------------------------------------------------------------------------
// Head + tail reader behind the viewers
// ---------------------------------------------------------------------------

export interface DigestSpec<S extends DigestState, P> {
  create(): S;
  fold(state: S, text: string): void;
  finish(state: S): P;
}

/**
 * Incremental reader behind a viewer. A long transcript is read as its first
 * 256 KB (the task) plus its last 8 MB (the latest work); after that only
 * appended bytes are parsed, and nothing is read while size and mtime hold.
 */
export class HeadTailReader<S extends DigestState, P> {
  private file: string | null = null;
  private state: S;
  private offset = 0;
  private size = -1;
  private mtimeMs = -1;
  private started = false;
  private inFlight: Promise<P | null> | null = null;

  constructor(private readonly spec: DigestSpec<S, P>) {
    this.state = spec.create();
  }

  attach(file: string): void {
    if (this.file !== file) {
      this.file = file;
      this.reset();
    }
  }

  refresh(): Promise<P | null> {
    // One read at a time: a second caller waits for the first and then sees no change.
    const run = (this.inFlight ?? Promise.resolve(null)).then(() => this.load(), () => this.load());
    this.inFlight = run;
    void run.finally(() => { if (this.inFlight === run) this.inFlight = null; }).catch(() => {});
    return run;
  }

  private reset(): void {
    this.state = this.spec.create();
    this.offset = 0;
    this.size = -1;
    this.mtimeMs = -1;
    this.started = false;
  }

  private async load(): Promise<P | null> {
    const { spec } = this;
    const file = this.file;
    if (!file) return null;
    let st: fs.Stats;
    try { st = await fs.promises.stat(file); } catch { return null; }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs) return spec.finish(this.state);

    // Work on a copy and commit state and offset together, so a read that fails
    // part-way is retried from the same place instead of folded twice.
    const fresh = st.size < this.offset;
    const work = fresh ? spec.create() : cloneDigestState(this.state);
    let offset = fresh ? 0 : this.offset;
    try {
      if (!(fresh ? false : this.started) && st.size > TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES) {
        const head = spec.create();
        await readCompleteLines(file, 0, TRANSCRIPT_HEAD_BYTES, text => spec.fold(head, text));
        work.prompt = head.prompt;
        work.skippedMiddle = true;
        // The tail window starts mid-line most of the time; begin at the next whole line.
        offset = await nextLineStart(file, st.size - TRANSCRIPT_TAIL_BYTES, st.size);
      }
      offset = await readCompleteLines(file, offset, st.size, text => spec.fold(work, text));
    } catch {
      return spec.finish(this.state);
    }
    this.state = work;
    this.offset = offset;
    this.started = true;
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return spec.finish(this.state);
  }
}
