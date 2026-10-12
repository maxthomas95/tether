import {
  REMOTE_SUBAGENT_MAX_AGENTS,
  type RemoteProbeTarget,
  type RemoteSubagentListReply,
  type RemoteSubagentReply,
  type RemoteSubagentRequest,
  type RemoteSubagentTranscriptReply,
} from '../usage/remote-protocol';
import { remoteProbeChannels } from '../usage/remote-probe-channels';
import {
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_TAIL_BYTES,
  createSubagentScan,
  createTranscriptState,
  finishTranscript,
  foldSubagentLines,
  foldTranscriptLines,
  isValidAgentId,
  parseSubagentMeta,
  type ParsedSubagentTranscript,
  type SubagentMeta,
  type SubagentScan,
  type SubagentSnapshot,
  type TranscriptState,
} from './subagents';
import type { RemoteSubagentSource } from './subagent-tracker';

/** Same miss backoff as the local project-folder scan: a session with no subagents stops paying for it. */
const LOOKUP_BACKOFF_MIN_MS = 2_500;
const LOOKUP_BACKOFF_MAX_MS = 180_000;
/** Viewer chunks fetched in one call; the rest follows on the viewer's next refresh. */
const MAX_TRANSCRIPT_ROUNDS = 12;
const MAX_VIEWER_READERS = 8;

export interface RemoteSubagentCaller {
  call(request: RemoteSubagentRequest): Promise<RemoteSubagentReply>;
  release(): void;
}

export interface RemoteSubagentSession {
  target: RemoteProbeTarget;
  /** Claude's session id. */
  sessionId: string;
}

interface FileState {
  offset: number;
  scan: SubagentScan;
  meta: SubagentMeta | null;
  metaMtimeMs: number;
  /** Remote times shifted onto this machine's clock. */
  mtimeMs: number;
  birthMs: number;
}

/** What the viewer has digested of one remote transcript, and where to continue. */
interface ViewerState {
  state: TranscriptState;
  offset: number;
  started: boolean;
  /** The next chunk starts mid-line (after a jump to the tail); drop its first fragment. */
  dropFragment: boolean;
}

/**
 * Subagents of one remote Claude session, read through the resident reader.
 * The reader keeps no state: this side holds a byte offset per file, asks for
 * what was appended since, and folds the lines it gets back with the same
 * parsers the local reader uses. An offset only moves together with the fold
 * of the lines it covers, and a failed request moves nothing, so a retry never
 * folds a line twice.
 */
export class RemoteSubagentReader implements RemoteSubagentSource {
  private readonly files = new Map<string, FileState>();
  private readonly viewers = new Map<string, ViewerState>();
  private project: string | undefined;
  private closed = false;
  private alive = true;
  private channel: RemoteSubagentCaller | null = null;
  private inFlight = 0;
  private nextLookupAt = 0;
  private lookupBackoffMs = LOOKUP_BACKOFF_MIN_MS;
  /** The last reply left bytes unread; the tracker should ask again soon. */
  backlog = false;

  constructor(
    private readonly session: RemoteSubagentSession,
    private readonly openChannel: () => RemoteSubagentCaller,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The reader on this host stays open while any live session holds it, however
   * long the session sits idle: closing it between subagent bursts would log in
   * again (a sudo, on an elevated host) for every burst. A finished session lets
   * go; reading its files again (the viewer) takes the hold only for that call.
   */
  setAlive(alive: boolean): void {
    this.alive = alive;
    if (!alive) this.letGo();
  }

  /** A subagent hook event arrived, so a missing folder is worth looking for again now. */
  resetLookup(): void {
    this.nextLookupAt = 0;
    this.lookupBackoffMs = LOOKUP_BACKOFF_MIN_MS;
  }

  private letGo(): void {
    if (this.inFlight > 0 || !this.channel) return;
    const channel = this.channel;
    this.channel = null;
    channel.release();
  }

  private async call(request: RemoteSubagentRequest): Promise<RemoteSubagentReply> {
    if (this.closed) throw new Error('Remote usage reader unavailable');
    this.channel ??= this.openChannel();
    this.inFlight++;
    try {
      return await this.channel.call(request);
    } finally {
      this.inFlight--;
      if (!this.alive || this.closed) this.letGo();
    }
  }

  private base(op: RemoteSubagentRequest['op']): RemoteSubagentRequest {
    const { target, sessionId } = this.session;
    return {
      op, cli: 'claude', sessionId, workingDir: target.workingDir,
      ...(target.home ? { home: target.home } : {}),
      ...(target.claudeHome ? { claudeHome: target.claudeHome } : {}),
      ...(this.project ? { project: this.project } : {}),
    };
  }

  async refresh(): Promise<{ snapshots: SubagentSnapshot[]; total: number }> {
    const known: NonNullable<RemoteSubagentRequest['known']> = {};
    for (const [id, state] of this.files) known[id] = { offset: state.offset, metaMtimeMs: state.metaMtimeMs, prompt: !!state.scan.firstPrompt };
    // The folder lookup is a direct hit or the project hint (cheap); only the
    // all-projects search backs off after a miss.
    const scan = this.now() >= this.nextLookupAt;
    let reply: RemoteSubagentReply;
    try {
      reply = await this.call({ ...this.base('subagents'), known, ...(scan ? {} : { scan: false }) });
    } catch (error) {
      // Nothing is waiting to be read if the request itself failed; leaving the
      // flag up would have the tracker re-ask every 250 ms through the retry wait.
      this.backlog = false;
      throw error;
    }
    if (this.closed) return { snapshots: [], total: 0 };
    if (reply.op !== 'subagents') throw new Error('Unexpected remote subagent reply');
    if (reply.found) this.resetLookup();
    else if (scan) {
      this.nextLookupAt = this.now() + this.lookupBackoffMs;
      this.lookupBackoffMs = Math.min(this.lookupBackoffMs * 2, LOOKUP_BACKOFF_MAX_MS);
    }
    return this.apply(reply);
  }

  private apply(reply: RemoteSubagentListReply): { snapshots: SubagentSnapshot[]; total: number } {
    this.backlog = reply.more;
    this.project = reply.project;
    if (!reply.found) {
      this.files.clear();
      return { snapshots: [], total: 0 };
    }
    // File ages are measured on the remote clock, then moved onto ours so the
    // tracker's "changed in the last 30s" rule is not skewed by clock drift.
    const skew = this.now() - reply.now;
    const shift = (iso: string | null) => {
      if (!iso || skew === 0) return iso;
      const at = Date.parse(iso);
      return Number.isNaN(at) ? iso : new Date(at + skew).toISOString();
    };
    const keep = new Set<string>();
    const snapshots: SubagentSnapshot[] = [];
    for (const file of reply.agents.slice(0, REMOTE_SUBAGENT_MAX_AGENTS)) {
      keep.add(file.id);
      let state = this.files.get(file.id);
      if (!state || file.reset) {
        state = { offset: 0, scan: createSubagentScan(), meta: null, metaMtimeMs: 0, mtimeMs: 0, birthMs: 0 };
        this.files.set(file.id, state);
      }
      // Validated and non-throwing from here, so the offset and the lines it
      // covers are committed together.
      if (file.text) foldSubagentLines(state.scan, file.text);
      state.offset = file.offset;
      if (file.meta !== undefined) state.meta = parseSubagentMeta(file.meta);
      state.metaMtimeMs = file.metaMtimeMs;
      state.mtimeMs = file.mtimeMs + skew;
      state.birthMs = file.birthMs + skew;
      // The transcript's own timestamps (start, last activity) are remote clock
      // too; shift them the same way, on a copy so the held scan stays as received.
      const scan = skew === 0 ? state.scan
        : { ...state.scan, startedAt: shift(state.scan.startedAt), lastActivityAt: shift(state.scan.lastActivityAt) };
      snapshots.push({ id: file.id, meta: state.meta, scan, mtimeMs: state.mtimeMs, birthMs: state.birthMs });
    }
    for (const id of this.files.keys()) if (!keep.has(id)) this.files.delete(id);
    return { snapshots, total: reply.total };
  }

  /**
   * Same shape as the local viewer reader: a long transcript is read as its
   * first lines (the task) plus its last 8 MB (the latest work), then only
   * appended bytes, folded into a bounded digest. Raw text is never kept, and a
   * call that fetches only part of a long file returns what it has so far; the
   * viewer's next refresh continues from there.
   */
  async transcript(agentId: string): Promise<ParsedSubagentTranscript | null> {
    if (!isValidAgentId(agentId)) return null;
    let viewer = this.viewers.get(agentId);
    if (!viewer) {
      viewer = { state: createTranscriptState(), offset: 0, started: false, dropFragment: false };
      this.viewers.set(agentId, viewer);
      while (this.viewers.size > MAX_VIEWER_READERS) {
        const oldest = this.viewers.keys().next().value;
        if (oldest === undefined) break;
        this.viewers.delete(oldest);
      }
    }
    for (let round = 0; round < MAX_TRANSCRIPT_ROUNDS && !this.closed; round++) {
      const reply: RemoteSubagentReply = await this.call({ ...this.base('subagent-transcript'), agentId, offset: viewer.offset });
      if (this.closed || this.viewers.get(agentId) !== viewer) break;
      if (reply.op !== 'subagent-transcript') throw new Error('Unexpected remote subagent reply');
      if (!reply.found) { this.viewers.delete(agentId); return null; }
      this.take(viewer, reply);
      if (!reply.more) break;
    }
    return finishTranscript(viewer.state);
  }

  private take(viewer: ViewerState, reply: RemoteSubagentTranscriptReply): void {
    if (reply.reset) {
      viewer.state = createTranscriptState();
      viewer.started = false;
      viewer.dropFragment = false;
    }
    let text = reply.text;
    if (viewer.dropFragment) {
      text = text.slice(text.indexOf('\n') + 1);
      viewer.dropFragment = false;
    }
    if (!viewer.started) {
      viewer.started = true;
      const tailStart = reply.size - TRANSCRIPT_TAIL_BYTES;
      if (reply.size > TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES && reply.offset < tailStart) {
        // Too long to read whole: keep the task from the start, skip the middle.
        const head = createTranscriptState();
        foldTranscriptLines(head, text);
        viewer.state.prompt = head.prompt;
        viewer.state.skippedMiddle = true;
        viewer.offset = tailStart;
        viewer.dropFragment = true;
        return;
      }
    }
    foldTranscriptLines(viewer.state, text);
    viewer.offset = reply.offset;
  }

  releaseTranscript(agentId: string): void {
    this.viewers.delete(agentId);
  }

  releaseAllTranscripts(): void {
    this.viewers.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.files.clear();
    this.viewers.clear();
    this.letGo();
  }
}

/** A reader for one session, drawing on the shared resident process for its host. */
export function openRemoteSubagentSource(session: RemoteSubagentSession): RemoteSubagentSource {
  return new RemoteSubagentReader(session, () => remoteProbeChannels.acquire(session.target));
}
