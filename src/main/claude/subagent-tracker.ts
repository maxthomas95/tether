import type { ChildAgentList, ChildAgentTranscript } from '../../shared/child-agents';
import { EMPTY_CHILD_AGENT_LIST } from '../../shared/child-agents';
import type { CliToolId } from '../../shared/types';
import type { RemoteProbeTarget } from '../usage/remote-protocol';
import {
  SubagentDirReader,
  SubagentTranscriptReader,
  buildChildAgentList,
  buildChildAgentTranscript,
  findSubagentsDirByScan,
  findSubagentsDirDirect,
  isValidAgentId,
  subagentTranscriptPath,
  type ParsedSubagentTranscript,
  type SubagentSnapshot,
} from './subagents';

/** Without hooks, a subagent counts as running if its transcript moved this recently. */
export const RUNNING_WINDOW_MS = 30_000;
const FAST_POLL_MS = 2_500;
const DISCOVERY_POLL_MS = 10_000;
const DEBOUNCE_MS = 750;
/**
 * The project-folder scan is a readdir plus a stat per project. After a miss it
 * waits this long, doubling to the cap, so a session that never spawns a
 * subagent stops paying for it. A subagent hook event starts over.
 */
const SCAN_BACKOFF_MIN_MS = 2_500;
const SCAN_BACKOFF_MAX_MS = 180_000;
const MAX_TRANSCRIPT_READERS = 8;
/** A remote source with more bytes waiting (response cap) is asked again right away. */
const BACKLOG_POLL_MS = 250;
/**
 * How long a hook-announced subagent with no file of its own keeps the fast
 * poll going. A lost SubagentStop would otherwise hold it for the whole session.
 */
const UNMATCHED_POLL_WINDOW_MS = 60_000;

/** What the tracker needs to know about a session; supplied by the session layer. */
export interface TrackedSession {
  cliTool: CliToolId;
  workingDir: string;
  /** Claude's own session id, which names the folder holding the subagents. */
  nativeSessionId: string | null;
  /** Remote sessions have no local transcript folder to read. */
  local: boolean;
  /** Set for SSH and Coder sessions: the host whose resident reader serves their files. */
  remote?: RemoteProbeTarget;
  alive: boolean;
  /** Hooks are delivering events, so the active set below can be trusted. */
  hookDriven: boolean;
  activeAgentIds: readonly string[];
}

export interface SubagentTrackerDeps {
  resolve(sessionId: string): TrackedSession | null;
  isEnabled(): boolean;
  /** Opens the reader for a remote session; without it remote sessions show no rows. */
  openRemote?(target: RemoteProbeTarget, nativeSessionId: string): RemoteSubagentSource;
  now?(): number;
}

/**
 * A remote session's files, read through the host's resident reader. It does
 * its own folder lookup (with the same miss backoff as the local scan) and
 * keeps its own viewer state, so the tracker only asks for lists and digests.
 */
export interface RemoteSubagentSource {
  refresh(): Promise<{ snapshots: SubagentSnapshot[]; total: number }>;
  transcript(agentId: string): Promise<ParsedSubagentTranscript | null>;
  releaseTranscript(agentId: string): void;
  releaseAllTranscripts(): void;
  /** A subagent hook event arrived: look for the folder again at once. */
  resetLookup(): void;
  /** The last refresh left data unread. */
  readonly backlog: boolean;
  /** The session is still running; its host reader is held only while it is. */
  setAlive(alive: boolean): void;
  close(): void;
}

type Listener = (sessionId: string, list: ChildAgentList) => void;

interface Entry {
  nativeId: string | null;
  dir: string | null;
  reader: SubagentDirReader | null;
  remote: RemoteSubagentSource | null;
  /** The last remote refresh failed, so its `backlog` says nothing about what is waiting. */
  remoteFailed: boolean;
  /** Hook-active ids with no listed file yet, and when each was first seen. */
  unmatchedSince: Map<string, number>;
  nextScanAt: number;
  scanBackoffMs: number;
  list: ChildAgentList;
  signature: string;
  expanded: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  rerun: boolean;
}

/**
 * Keeps each local Claude session's subagent list current without watching
 * files: hook events trigger a debounced refresh, and a stat poll runs only
 * while something is running, the list is expanded, or (without hooks) to
 * notice the first subagent.
 */
export class SubagentTracker {
  private deps: SubagentTrackerDeps | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();
  /** One incremental viewer reader per open agent; dropped when its viewer closes. */
  private readonly transcripts = new Map<string, SubagentTranscriptReader>();

  configure(deps: SubagentTrackerDeps): void {
    this.deps = deps;
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refresh now and return the result. */
  async list(sessionId: string): Promise<ChildAgentList> {
    if (!this.deps?.resolve(sessionId)) return EMPTY_CHILD_AGENT_LIST;
    const entry = this.entryFor(sessionId);
    await this.refresh(sessionId, entry);
    return entry.list;
  }

  /**
   * A hook or state event touched this session; refresh soon. Only a real
   * subagent event (`subagentEvent`) re-arms the folder scan; a state flip says
   * nothing about whether subagent files exist.
   */
  notify(sessionId: string, opts: { subagentEvent?: boolean } = {}): void {
    const ref = this.deps?.resolve(sessionId);
    if (!ref || !this.isEligible(ref)) return;
    const entry = this.entryFor(sessionId);
    if (opts.subagentEvent) { this.resetScanBackoff(entry); entry.remote?.resetLookup(); }
    if (entry.debounce) return;
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      void this.refresh(sessionId, entry);
    }, DEBOUNCE_MS);
    entry.debounce.unref?.();
  }

  /** The sidebar list for this session was opened or closed. */
  setExpanded(sessionId: string, expanded: boolean): void {
    if (!this.deps?.resolve(sessionId)) return;
    const entry = this.entryFor(sessionId);
    if (entry.expanded === expanded) return;
    entry.expanded = expanded;
    void this.refresh(sessionId, entry);
  }

  /** The renderer went away or reloaded, so nothing it had open is open any more. */
  resetExpanded(): void {
    this.transcripts.clear();
    for (const entry of this.entries.values()) entry.remote?.releaseAllTranscripts();
    for (const [sessionId, entry] of this.entries) {
      if (!entry.expanded) continue;
      entry.expanded = false;
      void this.refresh(sessionId, entry);
    }
  }

  releaseTranscript(sessionId: string, agentId: string): void {
    this.transcripts.delete(`${sessionId}:${agentId}`);
    this.entries.get(sessionId)?.remote?.releaseTranscript(agentId);
  }

  untrack(sessionId: string): void {
    for (const key of [...this.transcripts.keys()]) if (key.startsWith(`${sessionId}:`)) this.transcripts.delete(key);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    this.closeRemote(entry);
    this.entries.delete(sessionId);
  }

  async getTranscript(sessionId: string, agentId: string): Promise<ChildAgentTranscript | null> {
    if (!isValidAgentId(agentId) || !this.deps?.resolve(sessionId)) return null;
    const entry = this.entryFor(sessionId);
    if (this.deps.resolve(sessionId)?.remote) return this.getRemoteTranscript(sessionId, entry, agentId);
    // Claimed before awaiting so a release that arrives meanwhile is not undone.
    const reader = this.readerFor(`${sessionId}:${agentId}`);
    await this.refresh(sessionId, entry);
    const agent = entry.list.agents.find(a => a.id === agentId);
    const file = entry.dir ? subagentTranscriptPath(entry.dir, agentId) : null;
    if (!agent || !file) return null;
    reader.attach(file);
    const parsed = await reader.refresh();
    return parsed ? buildChildAgentTranscript(agent, parsed) : null;
  }

  private async getRemoteTranscript(sessionId: string, entry: Entry, agentId: string): Promise<ChildAgentTranscript | null> {
    await this.refresh(sessionId, entry);
    const agent = entry.list.agents.find(a => a.id === agentId);
    if (!agent || !entry.remote) return null;
    const parsed = await entry.remote.transcript(agentId);
    return parsed ? buildChildAgentTranscript(agent, parsed) : null;
  }

  private closeRemote(entry: Entry): void {
    try { entry.remote?.close(); } catch { /* releasing a reader must not break tracking */ }
    entry.remote = null;
  }

  private readerFor(key: string): SubagentTranscriptReader {
    let reader = this.transcripts.get(key);
    if (!reader) {
      reader = new SubagentTranscriptReader();
      this.transcripts.set(key, reader);
      // A viewer that never released (renderer crash) must not pin memory.
      while (this.transcripts.size > MAX_TRANSCRIPT_READERS) {
        const oldest = this.transcripts.keys().next().value;
        if (oldest === undefined) break;
        this.transcripts.delete(oldest);
      }
    }
    return reader;
  }

  private resetScanBackoff(entry: Entry): void {
    entry.nextScanAt = 0;
    entry.scanBackoffMs = SCAN_BACKOFF_MIN_MS;
  }

  dispose(): void {
    this.transcripts.clear();
    for (const id of [...this.entries.keys()]) this.untrack(id);
    this.listeners.clear();
  }

  private isEligible(ref: TrackedSession): boolean {
    return !!this.deps?.isEnabled() && ref.cliTool === 'claude' && !!ref.nativeSessionId
      && (ref.local || (!!ref.remote && !!this.deps.openRemote));
  }

  private entryFor(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        nativeId: null, dir: null, reader: null, remote: null, remoteFailed: false, unmatchedSince: new Map(), nextScanAt: 0, scanBackoffMs: SCAN_BACKOFF_MIN_MS,
        list: EMPTY_CHILD_AGENT_LIST, signature: JSON.stringify(EMPTY_CHILD_AGENT_LIST), expanded: false,
        timer: null, debounce: null, inFlight: null, rerun: false,
      };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private refresh(sessionId: string, entry: Entry): Promise<void> {
    if (entry.inFlight) {
      entry.rerun = true;
      return entry.inFlight;
    }
    const run = this.doRefresh(sessionId, entry).finally(() => {
      entry.inFlight = null;
      if (entry.rerun && this.entries.get(sessionId) === entry) {
        entry.rerun = false;
        void this.refresh(sessionId, entry);
      }
    });
    entry.inFlight = run;
    return run;
  }

  private async doRefresh(sessionId: string, entry: Entry): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    const ref = deps.resolve(sessionId);
    if (!ref) { this.untrack(sessionId); return; }
    const now = (deps.now ?? Date.now)();

    try {
      if (!this.isEligible(ref)) {
        entry.dir = null;
        entry.reader = null;
        this.closeRemote(entry);
        this.publish(sessionId, entry, EMPTY_CHILD_AGENT_LIST);
        return;
      }
      if (ref.nativeSessionId !== entry.nativeId) {
        entry.nativeId = ref.nativeSessionId;
        entry.dir = null;
        entry.reader = null;
        this.closeRemote(entry);
        this.resetScanBackoff(entry);
      }
      if (ref.remote) {
        entry.remote ??= this.deps?.openRemote?.(ref.remote, ref.nativeSessionId!) ?? null;
        entry.remote?.setAlive(ref.alive);
        let result: { snapshots: SubagentSnapshot[]; total: number } = { snapshots: [], total: 0 };
        try {
          if (entry.remote) result = await entry.remote.refresh();
          entry.remoteFailed = false;
        } catch (error) {
          entry.remoteFailed = true;
          throw error;
        }
        const { snapshots, total } = result;
        this.publish(sessionId, entry, this.buildList(snapshots, total, ref, now));
        this.schedule(sessionId, entry, ref, now);
        return;
      }
      if (!entry.reader) {
        entry.dir = findSubagentsDirDirect(ref.nativeSessionId!, ref.workingDir);
        if (!entry.dir && now >= entry.nextScanAt) {
          entry.dir = findSubagentsDirByScan(ref.nativeSessionId!);
          if (!entry.dir) {
            entry.nextScanAt = now + entry.scanBackoffMs;
            entry.scanBackoffMs = Math.min(entry.scanBackoffMs * 2, SCAN_BACKOFF_MAX_MS);
          }
        }
        entry.reader = entry.dir ? new SubagentDirReader(entry.dir) : null;
      }
      if (!entry.reader) {
        this.publish(sessionId, entry, EMPTY_CHILD_AGENT_LIST);
      } else {
        const { snapshots, total } = await entry.reader.refresh();
        this.publish(sessionId, entry, this.buildList(snapshots, total, ref, now));
      }
      this.schedule(sessionId, entry, ref, now);
    } catch {
      // The files are Claude's and can change under us; the next tick retries.
      this.schedule(sessionId, entry, ref, now);
    }
  }

  private buildList(snapshots: SubagentSnapshot[], total: number, ref: TrackedSession, now: number): ChildAgentList {
    const active = new Set(ref.activeAgentIds);
    return buildChildAgentList(
      snapshots,
      (id, mtimeMs) => ref.alive && (ref.hookDriven ? active.has(id) : now - mtimeMs <= RUNNING_WINDOW_MS),
      total,
    );
  }

  private schedule(sessionId: string, entry: Entry, ref: TrackedSession, now: number): void {
    if (!ref.alive || !this.deps?.isEnabled() || this.entries.get(sessionId) !== entry) return;
    const anyRunning = entry.list.agents.some(a => a.state === 'running');
    let delay: number | null = null;
    // A hook can announce a subagent before its first file exists, so an active
    // id with no listed file keeps the poll going, for a minute at most.
    const listed = new Set(entry.list.agents.map(a => a.id));
    const unmatched = ref.activeAgentIds.filter(id => !listed.has(id));
    for (const id of [...entry.unmatchedSince.keys()]) if (!unmatched.includes(id)) entry.unmatchedSince.delete(id);
    for (const id of unmatched) if (!entry.unmatchedSince.has(id)) entry.unmatchedSince.set(id, now);
    const awaitingFile = unmatched.some(id => now - entry.unmatchedSince.get(id)! < UNMATCHED_POLL_WINDOW_MS);
    if (entry.remote?.backlog && !entry.remoteFailed) delay = BACKLOG_POLL_MS;
    else if (anyRunning || entry.expanded || awaitingFile) delay = FAST_POLL_MS;
    else if (!ref.hookDriven) delay = DISCOVERY_POLL_MS;
    if (delay === null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.refresh(sessionId, entry);
    }, delay);
    entry.timer.unref?.();
  }

  private publish(sessionId: string, entry: Entry, list: ChildAgentList): void {
    const signature = JSON.stringify(list);
    entry.list = list;
    if (signature === entry.signature) return;
    entry.signature = signature;
    for (const listener of this.listeners) {
      try { listener(sessionId, list); } catch { /* a bad listener must not stop polling */ }
    }
  }
}

export const subagentTracker = new SubagentTracker();
