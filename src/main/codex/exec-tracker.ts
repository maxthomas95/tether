import type { ChildAgentInfo, ChildAgentList, ChildAgentTranscript } from '../../shared/child-agents';
import { EMPTY_CHILD_AGENT_LIST } from '../../shared/child-agents';
import type { CliToolId } from '../../shared/types';
import {
  CodexRolloutReader,
  CodexTranscriptReader,
  buildCodexExecTranscript,
  findRolloutByThreadId,
  isValidThreadId,
  toCodexExecChildInfo,
  type CodexExecHookInfo,
} from './exec-rollouts';

const FAST_POLL_MS = 2_500;
/** A run that is running with no file to follow: a slow tick lets a lost Stop age out. */
const SLOW_POLL_MS = 10_000;
const DEBOUNCE_MS = 750;
const LOOKUP_RETRY_MS = 5_000;
/**
 * A run that has not written a rollout this long after its first hook is
 * treated as ephemeral. It also bounds how long a hook-announced run with no
 * file keeps the fast poll going: a lost Stop must not hold it for the session.
 */
const ROLLOUT_GIVE_UP_MS = 60_000;
const MAX_TRANSCRIPT_READERS = 8;
const MAX_CHILDREN = 50;

const RUNNING_TYPES: ReadonlySet<string> = new Set([
  'session_start', 'turn_start', 'tool_complete', 'permission_prompt', 'compact_start', 'compact_complete',
]);
const DONE_TYPES: ReadonlySet<string> = new Set(['turn_complete', 'turn_interrupted', 'session_end']);

const EMPTY_TRANSCRIPT = { prompt: null, entries: [], result: null, truncated: false };

export const NO_ROLLOUT_NOTE = 'No rollout file was found for this run (for example codex exec --ephemeral), '
  + 'so only what the hooks reported is shown.';

/** What the tracker needs to know about a session; supplied by the session layer. */
export interface ExecTrackedSession {
  cliTool: CliToolId;
  /** Remote sessions have no Codex hooks and no rollout on this machine. */
  local: boolean;
  alive: boolean;
}

export interface CodexExecTrackerDeps {
  resolve(sessionId: string): ExecTrackedSession | null;
  isEnabled(): boolean;
  codexHome(): string;
  now?(): number;
}

export interface CodexExecHookEvent {
  type: string;
  payload?: Record<string, unknown>;
}

type Listener = (sessionId: string, list: ChildAgentList) => void;

interface Child {
  threadId: string;
  firstSeenMs: number;
  hook: CodexExecHookInfo | null;
  reader: CodexRolloutReader | null;
  rolloutSearchedAt: number;
  rolloutGaveUp: boolean;
}

interface Entry {
  children: Map<string, Child>;
  list: ChildAgentList;
  signature: string;
  expanded: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  rerun: boolean;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

/**
 * Lists the `codex exec` runs a local Claude session started through its Bash
 * tool. Codex's lifecycle hooks are installed globally and a child inherits
 * the Claude pane's Tether env, so a run reports as that session with
 * `source: 'codex'`; those events identify the run (keyed by Codex thread id)
 * and give running/done. The rollout file under the Codex home, found by that
 * exact thread id, supplies the prompt, model, effort, tokens and the viewer's
 * digest. There is no inference from transcripts: a run whose hooks Codex did
 * not run (not trusted via /hooks, or tracking off) is simply not listed.
 *
 * Nothing here reads the terminal or touches the parent session's status.
 */
export class CodexExecTracker {
  private deps: CodexExecTrackerDeps | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();
  /** One incremental viewer reader per open run; dropped when its viewer closes. */
  private readonly transcripts = new Map<string, CodexTranscriptReader>();

  configure(deps: CodexExecTrackerDeps): void {
    this.deps = deps;
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refresh now and return the result. */
  async list(sessionId: string): Promise<ChildAgentList> {
    const ref = this.deps?.resolve(sessionId);
    if (!ref || !this.isEligible(ref)) return EMPTY_CHILD_AGENT_LIST;
    const entry = this.entryFor(sessionId);
    await this.refresh(sessionId, entry);
    return entry.list;
  }

  has(sessionId: string, threadId: string): boolean {
    return this.entries.get(sessionId)?.children.has(threadId) ?? false;
  }

  /**
   * A Codex lifecycle hook arrived tagged with this Claude session. Subagent
   * events, and any event a Codex subagent sends inside a run, are not
   * children of the Claude session and are ignored.
   */
  ingest(sessionId: string, event: CodexExecHookEvent): void {
    const deps = this.deps;
    const ref = deps?.resolve(sessionId);
    if (!deps || !ref || !this.isEligible(ref)) return;
    const payload = event.payload ?? {};
    const threadId = boundedString(payload.toolSessionId, 256);
    if (!isValidThreadId(threadId)) return;
    // codex-rs/hooks/src/schema.rs: `agent_id` is set only on events fired inside a Codex subagent
    // (and required on SubagentStart/Stop); SessionStart, SessionEnd, Stop and Interrupt never carry it.
    if (event.type === 'subagent_start' || event.type === 'subagent_stop') return;
    if (boundedString(payload.agentId, 256)) return;
    const state = RUNNING_TYPES.has(event.type) ? 'running' : DONE_TYPES.has(event.type) ? 'done' : null;
    if (!state) return;

    const now = (deps.now ?? Date.now)();
    const parsedAt = typeof payload.at === 'string' ? Date.parse(payload.at) : Number.NaN;
    const at = Number.isNaN(parsedAt) ? now : parsedAt;
    const entry = this.entryFor(sessionId);
    const child = entry.children.get(threadId) ?? this.addChild(entry, threadId, now);
    // Each hook is its own process, so two can arrive out of order.
    if (child.hook && at < child.hook.lastAtMs) return;
    const model = boundedString(payload.model, 128) ?? child.hook?.model;
    child.hook = {
      state,
      firstAtMs: child.hook ? Math.min(child.hook.firstAtMs, at) : at,
      lastAtMs: at,
      ...(model ? { model } : {}),
    };
    this.notify(sessionId);
  }

  /** The renderer went away or reloaded, so nothing it had open is open any more. */
  resetExpanded(): void {
    this.transcripts.clear();
    for (const [sessionId, entry] of this.entries) {
      if (!entry.expanded) continue;
      entry.expanded = false;
      void this.refresh(sessionId, entry);
    }
  }

  releaseTranscript(sessionId: string, threadId: string): void {
    this.transcripts.delete(`${sessionId}:${threadId}`);
  }

  /** A state event touched this session; refresh soon. */
  notify(sessionId: string): void {
    const ref = this.deps?.resolve(sessionId);
    if (!ref || !this.isEligible(ref)) return;
    const entry = this.entryFor(sessionId);
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

  untrack(sessionId: string): void {
    for (const key of [...this.transcripts.keys()]) if (key.startsWith(`${sessionId}:`)) this.transcripts.delete(key);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    this.entries.delete(sessionId);
  }

  async getTranscript(sessionId: string, threadId: string): Promise<ChildAgentTranscript | null> {
    const deps = this.deps;
    if (!deps || !isValidThreadId(threadId)) return null;
    const ref = deps.resolve(sessionId);
    if (!ref || !this.isEligible(ref)) return null;
    const entry = this.entryFor(sessionId);
    // Claimed before awaiting so a release that arrives meanwhile is not undone.
    const reader = this.readerFor(`${sessionId}:${threadId}`);
    await this.refresh(sessionId, entry);
    const child = entry.children.get(threadId);
    const agent = entry.list.agents.find(a => a.id === threadId);
    if (!child || !agent) return null;
    if (!child.reader) {
      // The viewer is a reason to look again even after giving up.
      child.rolloutGaveUp = false;
      child.rolloutSearchedAt = 0;
      await this.locateRollout(child, deps);
    }
    if (!child.reader) return buildCodexExecTranscript(agent, EMPTY_TRANSCRIPT, NO_ROLLOUT_NOTE);
    reader.attach(child.reader.file);
    const parsed = await reader.refresh();
    return parsed ? buildCodexExecTranscript(agent, parsed) : buildCodexExecTranscript(agent, EMPTY_TRANSCRIPT, NO_ROLLOUT_NOTE);
  }

  private readerFor(key: string): CodexTranscriptReader {
    let reader = this.transcripts.get(key);
    if (!reader) {
      reader = new CodexTranscriptReader();
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

  dispose(): void {
    this.transcripts.clear();
    for (const id of [...this.entries.keys()]) this.untrack(id);
    this.listeners.clear();
  }

  private isEligible(ref: ExecTrackedSession): boolean {
    return !!this.deps?.isEnabled() && ref.cliTool === 'claude' && ref.local;
  }

  private entryFor(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        children: new Map(),
        list: EMPTY_CHILD_AGENT_LIST, signature: JSON.stringify(EMPTY_CHILD_AGENT_LIST), expanded: false,
        timer: null, debounce: null, inFlight: null, rerun: false,
      };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private addChild(entry: Entry, threadId: string, now: number): Child {
    const child: Child = {
      threadId, firstSeenMs: now, hook: null, reader: null, rolloutSearchedAt: 0, rolloutGaveUp: false,
    };
    entry.children.set(threadId, child);
    if (entry.children.size > MAX_CHILDREN) this.evictOldest(entry);
    return child;
  }

  /** Drop the oldest child that is not the one just added. */
  private evictOldest(entry: Entry): void {
    let oldest: Child | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    const newest = [...entry.children.values()].at(-1);
    for (const child of entry.children.values()) {
      if (child === newest) continue;
      const at = child.hook?.lastAtMs ?? child.firstSeenMs;
      if (at < oldestAt) { oldest = child; oldestAt = at; }
    }
    if (!oldest) return;
    entry.children.delete(oldest.threadId);
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

    try {
      if (!this.isEligible(ref)) {
        this.publish(sessionId, entry, EMPTY_CHILD_AGENT_LIST);
        return;
      }
      const now = (deps.now ?? Date.now)();
      for (const child of entry.children.values()) await this.readChild(child, deps);
      this.publish(sessionId, entry, this.buildList(entry, ref, now));
    } catch {
      // The files are Codex's and can change under us; the next tick retries.
    }
    this.schedule(sessionId, entry, ref);
  }

  private async locateRollout(child: Child, deps: CodexExecTrackerDeps): Promise<void> {
    const now = (deps.now ?? Date.now)();
    if (child.reader || child.rolloutGaveUp || now - child.rolloutSearchedAt < LOOKUP_RETRY_MS) return;
    child.rolloutSearchedAt = now;
    const file = await findRolloutByThreadId(child.threadId, deps.codexHome(), child.hook?.firstAtMs ?? child.firstSeenMs, now);
    if (file) child.reader = new CodexRolloutReader(file);
    else if (now - child.firstSeenMs > ROLLOUT_GIVE_UP_MS) child.rolloutGaveUp = true;
  }

  private async readChild(child: Child, deps: CodexExecTrackerDeps): Promise<void> {
    if (!child.reader) await this.locateRollout(child, deps);
    if (child.reader && !(await child.reader.refresh())) child.reader = null;
  }

  private buildList(entry: Entry, ref: ExecTrackedSession, now: number): ChildAgentList {
    const infos: ChildAgentInfo[] = [...entry.children.values()].map(child => toCodexExecChildInfo({
      threadId: child.threadId,
      scan: child.reader?.scan ?? null,
      rolloutMtimeMs: child.reader?.mtimeMs ?? null,
      hook: child.hook,
      nowMs: now,
      alive: ref.alive,
    }));
    infos.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
    return { agents: infos, total: infos.length };
  }

  private schedule(sessionId: string, entry: Entry, ref: ExecTrackedSession): void {
    if (!ref.alive || !this.deps?.isEnabled() || this.entries.get(sessionId) !== entry) return;
    let fast = entry.expanded;
    let slow = false;
    for (const agent of entry.list.agents) {
      if (agent.state !== 'running') continue;
      const child = entry.children.get(agent.id);
      // A file to follow, or one still expected (give-up bounds this to a minute).
      // A hook-only run has nothing to poll; a slow tick lets a lost Stop age out.
      if (child && (child.reader || !child.rolloutGaveUp)) fast = true;
      else slow = true;
    }
    const delay = fast ? FAST_POLL_MS : slow ? SLOW_POLL_MS : null;
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

export const codexExecTracker = new CodexExecTracker();
