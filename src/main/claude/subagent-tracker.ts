import type { ChildAgentList, ChildAgentTranscript } from '../../shared/child-agents';
import { EMPTY_CHILD_AGENT_LIST } from '../../shared/child-agents';
import type { CliToolId } from '../../shared/types';
import {
  SubagentDirReader,
  buildChildAgentList,
  buildChildAgentTranscript,
  findSubagentsDir,
  isValidAgentId,
  readSubagentTranscriptText,
} from './subagents';

/** Without hooks, a subagent counts as running if its transcript moved this recently. */
export const RUNNING_WINDOW_MS = 30_000;
const FAST_POLL_MS = 2_500;
const DISCOVERY_POLL_MS = 10_000;
const DEBOUNCE_MS = 750;
const DIR_RETRY_MS = 10_000;

/** What the tracker needs to know about a session; supplied by the session layer. */
export interface TrackedSession {
  cliTool: CliToolId;
  workingDir: string;
  /** Claude's own session id, which names the folder holding the subagents. */
  nativeSessionId: string | null;
  /** Remote sessions have no local transcript folder to read. */
  local: boolean;
  alive: boolean;
  /** Hooks are delivering events, so the active set below can be trusted. */
  hookDriven: boolean;
  activeAgentIds: readonly string[];
}

export interface SubagentTrackerDeps {
  resolve(sessionId: string): TrackedSession | null;
  isEnabled(): boolean;
  now?(): number;
}

type Listener = (sessionId: string, list: ChildAgentList) => void;

interface Entry {
  nativeId: string | null;
  dir: string | null;
  reader: SubagentDirReader | null;
  dirCheckedAt: number;
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

  /** A hook or state event touched this session; refresh soon. */
  notify(sessionId: string): void {
    const ref = this.deps?.resolve(sessionId);
    if (!ref || !this.isEligible(ref)) return;
    const entry = this.entryFor(sessionId);
    entry.dirCheckedAt = 0;
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
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    this.entries.delete(sessionId);
  }

  async getTranscript(sessionId: string, agentId: string): Promise<ChildAgentTranscript | null> {
    if (!isValidAgentId(agentId) || !this.deps?.resolve(sessionId)) return null;
    const entry = this.entryFor(sessionId);
    await this.refresh(sessionId, entry);
    const agent = entry.list.agents.find(a => a.id === agentId);
    if (!agent || !entry.dir) return null;
    const raw = await readSubagentTranscriptText(entry.dir, agentId);
    return raw ? buildChildAgentTranscript(agent, raw.text, raw.truncated) : null;
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.untrack(id);
    this.listeners.clear();
  }

  private isEligible(ref: TrackedSession): boolean {
    return !!this.deps?.isEnabled() && ref.cliTool === 'claude' && ref.local && !!ref.nativeSessionId;
  }

  private entryFor(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        nativeId: null, dir: null, reader: null, dirCheckedAt: 0,
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

    try {
      if (!this.isEligible(ref)) {
        entry.dir = null;
        entry.reader = null;
        this.publish(sessionId, entry, EMPTY_CHILD_AGENT_LIST);
        return;
      }
      const now = (deps.now ?? Date.now)();
      if (ref.nativeSessionId !== entry.nativeId) {
        entry.nativeId = ref.nativeSessionId;
        entry.dir = null;
        entry.reader = null;
        entry.dirCheckedAt = 0;
      }
      if (!entry.reader && now - entry.dirCheckedAt >= DIR_RETRY_MS) {
        entry.dirCheckedAt = now;
        entry.dir = findSubagentsDir(ref.nativeSessionId!, ref.workingDir);
        entry.reader = entry.dir ? new SubagentDirReader(entry.dir) : null;
      }
      if (!entry.reader) {
        this.publish(sessionId, entry, EMPTY_CHILD_AGENT_LIST);
      } else {
        const { snapshots, total } = await entry.reader.refresh();
        const active = new Set(ref.activeAgentIds);
        const list = buildChildAgentList(
          snapshots,
          (id, mtimeMs) => ref.alive && (ref.hookDriven ? active.has(id) : now - mtimeMs <= RUNNING_WINDOW_MS),
          total,
        );
        this.publish(sessionId, entry, list);
      }
      this.schedule(sessionId, entry, ref);
    } catch {
      // The files are Claude's and can change under us; the next tick retries.
      this.schedule(sessionId, entry, ref);
    }
  }

  private schedule(sessionId: string, entry: Entry, ref: TrackedSession): void {
    if (!ref.alive || !this.deps?.isEnabled() || this.entries.get(sessionId) !== entry) return;
    const anyRunning = entry.list.agents.some(a => a.state === 'running');
    let delay: number | null = null;
    if (anyRunning || entry.expanded) delay = FAST_POLL_MS;
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
