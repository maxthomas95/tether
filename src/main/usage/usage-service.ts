import * as fs from 'node:fs';
import { createLogger } from '../logger';
import { transcriptPath, scanAllTranscripts } from '../claude/transcripts';
import { scanAllCodexTranscripts } from '../codex/transcripts';
import { parseJsonlFile, type ParsedMessage } from './jsonl-parser';
import { parseCodexJsonl } from './codex-jsonl-parser';
import { readCrushSessions } from '../opencode/usage-reader';
import { getDb, saveDb, type PersistedSessionUsage } from '../db/database';
import type { SessionUsage, UsageModelBreakdown, UsageInfo, DailyUsage, CliToolId } from '../../shared/types';

const log = createLogger('usage');

const WATCH_DEBOUNCE_MS = 300;
const WATCH_POLL_INTERVAL_MS = 2_000;
const RESCAN_INTERVAL_MS = 5 * 60 * 1_000;

interface TrackedSession {
  sessionId: string;
  cliTool: CliToolId;
  workingDir: string;
  filePath: string;
  watching: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  usage: SessionUsage;
  /**
   * Codex only: model id active at the end of the last parse. Codex publishes
   * the model in `turn_context` lines that precede each `token_count`, so an
   * appended chunk that begins with token_count needs the prior model to
   * cost-attribute correctly.
   */
  lastSeenModel?: string | null;
}

function emptySessionUsage(sessionId: string, cliTool: CliToolId): SessionUsage {
  return {
    sessionId,
    cliTool,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    models: [],
    messageCount: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    parsedByteOffset: 0,
  };
}

function mergeMessages(existing: SessionUsage, messages: ParsedMessage[], newOffset: number): SessionUsage {
  if (messages.length === 0) return { ...existing, parsedByteOffset: newOffset };

  // Accumulate model breakdowns
  const modelMap = new Map<string, UsageModelBreakdown>();
  for (const m of existing.models) {
    modelMap.set(m.model, { ...m });
  }

  let { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost, messageCount } = existing;
  let firstMessageAt = existing.firstMessageAt;
  let lastMessageAt = existing.lastMessageAt;

  for (const msg of messages) {
    inputTokens += msg.inputTokens;
    outputTokens += msg.outputTokens;
    cacheCreationTokens += msg.cacheCreation5m + msg.cacheCreation1h;
    cacheReadTokens += msg.cacheReadTokens;
    totalCost += msg.cost;
    messageCount++;

    if (!firstMessageAt || msg.timestamp < firstMessageAt) {
      firstMessageAt = msg.timestamp;
    }
    if (!lastMessageAt || msg.timestamp > lastMessageAt) {
      lastMessageAt = msg.timestamp;
    }

    const mb = modelMap.get(msg.model) || {
      model: msg.model,
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0,
    };
    mb.inputTokens += msg.inputTokens;
    mb.outputTokens += msg.outputTokens;
    mb.cacheCreationTokens += msg.cacheCreation5m + msg.cacheCreation1h;
    mb.cacheReadTokens += msg.cacheReadTokens;
    mb.cost += msg.cost;
    modelMap.set(msg.model, mb);
  }

  return {
    sessionId: existing.sessionId,
    cliTool: existing.cliTool,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalCost,
    models: Array.from(modelMap.values()),
    messageCount,
    firstMessageAt,
    lastMessageAt,
    parsedByteOffset: newOffset,
  };
}

class UsageService {
  private tracked = new Map<string, TrackedSession>();
  private callback: ((info: UsageInfo) => void) | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;

  onUpdate(cb: (info: UsageInfo) => void): void {
    this.callback = cb;
  }

  start(): void {
    log.info('Usage service started');
    // Load persisted summaries into memory
    const db = getDb();
    for (const summary of db.usageSummaries) {
      if (!this.tracked.has(summary.sessionId)) {
        const cliTool = (summary.cliTool as CliToolId) || 'claude';
        this.tracked.set(summary.sessionId, {
          sessionId: summary.sessionId,
          cliTool,
          workingDir: summary.workingDir,
          filePath: summary.filePath ?? (cliTool === 'claude' ? transcriptPath(summary.workingDir, summary.sessionId) : ''),
          watching: false,
          debounceTimer: null,
          usage: {
            sessionId: summary.sessionId,
            cliTool,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            cacheCreationTokens: summary.cacheCreationTokens,
            cacheReadTokens: summary.cacheReadTokens,
            totalCost: summary.totalCost,
            models: summary.models,
            messageCount: summary.messageCount,
            firstMessageAt: summary.firstMessageAt,
            lastMessageAt: summary.lastMessageAt,
            parsedByteOffset: summary.parsedByteOffset,
          },
          // lastSeenModel isn't persisted; the next turn_context line resets it.
          // A handful of token_count events appended pre-turn_context after a
          // restart will attribute to 'unknown' until the next turn_context.
          lastSeenModel: null,
        });
      }
    }

    // Non-blocking backfill of any sessions we don't know about yet. The
    // event loop keeps the UI responsive while we chew through historical
    // JSONLs. Afterwards, a periodic rescan catches appends to historical
    // files from out-of-band claude runs.
    setImmediate(() => this.backfillFromDisk());
    this.rescanTimer = setInterval(() => this.backfillFromDisk(), RESCAN_INTERVAL_MS);
  }

  /**
   * Scan ~/.claude/projects/ for every JSONL transcript, and parse any new
   * files or any appends to files we've already seen. Only token counts,
   * model names, and timestamps are persisted — prompts and responses are
   * parsed transiently then discarded. Safe to call repeatedly.
   *
   * Also scans Crush (OpenCode) SQLite database for historical sessions.
   */
  private backfillFromDisk(): void {
    // 1. Backfill Claude Code transcripts (JSONL)
    let discovered;
    try {
      discovered = scanAllTranscripts();
    } catch (err) {
      log.warn('Transcript scan failed', { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let newSessions = 0;
    let updatedSessions = 0;

    for (const d of discovered) {
      const existing = this.tracked.get(d.sessionId);
      if (!existing) {
        // New-to-us session. Create an in-memory entry and parse in full.
        const session: TrackedSession = {
          sessionId: d.sessionId,
          cliTool: 'claude',
          workingDir: d.projectDirName,
          filePath: d.filePath,
          watching: false,
          debounceTimer: null,
          usage: emptySessionUsage(d.sessionId, 'claude'),
        };
        this.tracked.set(d.sessionId, session);
        this.parseSession(session);
        newSessions++;
        continue;
      }
      // Already known. Only re-parse if the file grew since we last looked.
      if (d.size > existing.usage.parsedByteOffset) {
        this.parseSession(existing);
        updatedSessions++;
      }
    }

    // 1b. Backfill Codex transcripts (JSONL with event_msg/token_count lines).
    let codexDiscovered: ReturnType<typeof scanAllCodexTranscripts> = [];
    try {
      codexDiscovered = scanAllCodexTranscripts();
    } catch (err) {
      log.warn('Codex transcript scan failed', { error: err instanceof Error ? err.message : String(err) });
    }

    for (const d of codexDiscovered) {
      const existing = this.tracked.get(d.sessionId);
      if (!existing) {
        const session: TrackedSession = {
          sessionId: d.sessionId,
          cliTool: 'codex',
          workingDir: d.cwd,
          filePath: d.filePath,
          watching: false,
          debounceTimer: null,
          usage: emptySessionUsage(d.sessionId, 'codex'),
          lastSeenModel: null,
        };
        this.tracked.set(d.sessionId, session);
        this.parseSession(session);
        newSessions++;
        continue;
      }
      if (d.size > existing.usage.parsedByteOffset) {
        this.parseSession(existing);
        updatedSessions++;
      }
    }

    // 2. Backfill Crush/OpenCode sessions from SQLite
    const crushSessions = readCrushSessions();
    for (const cs of crushSessions) {
      const existing = this.tracked.get(cs.id);
      if (!existing) {
        // New-to-us Crush session — load from DB (cost is pre-computed by Crush)
        const modelBreakdown: UsageModelBreakdown = cs.model ? {
          model: cs.model,
          inputTokens: cs.promptTokens,
          outputTokens: cs.completionTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: cs.cost,
        } : {
          model: 'unknown',
          inputTokens: cs.promptTokens,
          outputTokens: cs.completionTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: cs.cost,
        };

        const session: TrackedSession = {
          sessionId: cs.id,
          cliTool: 'opencode',
          workingDir: cs.directory,
          filePath: '',
          watching: false,
          debounceTimer: null,
          usage: {
            sessionId: cs.id,
            cliTool: 'opencode',
            inputTokens: cs.promptTokens,
            outputTokens: cs.completionTokens,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: cs.cost,
            models: [modelBreakdown],
            messageCount: cs.messageCount,
            firstMessageAt: cs.createdAt,
            lastMessageAt: cs.updatedAt,
            parsedByteOffset: 0,
          },
        };
        this.tracked.set(cs.id, session);
        this.persistSession(session);
        newSessions++;
      }
    }

    if (newSessions > 0 || updatedSessions > 0) {
      log.info('Transcript scan complete', {
        total: discovered.length + codexDiscovered.length + crushSessions.length,
        newSessions,
        updatedSessions,
      });
      this.notifyUpdate();
    }
  }

  trackSession(sessionId: string, workingDir: string, cliTool: CliToolId = 'claude'): void {
    const existing = this.tracked.get(sessionId);
    if (existing) {
      // start() pre-loads DB summaries into `tracked` without a watcher,
      // so a subsequent trackSession from session:create used to silently
      // skip the watcher. Attach one for any transcript-backed CLI whose
      // file path we already know.
      if (!existing.watching && existing.filePath && (existing.cliTool === 'claude' || existing.cliTool === 'codex')) {
        this.startWatching(existing);
      }
      return;
    }

    // Check for persisted data
    const db = getDb();
    const persisted = db.usageSummaries.find(s => s.sessionId === sessionId);

    // Prefer the authoritative filePath from a scan-discovered summary —
    // its workingDir is the encoded project dir name, which is lossy to
    // recover into a real path. transcriptPath() is correct for fresh
    // Tether sessions where workingDir is the actual cwd.
    //
    // Codex stores transcripts at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
    // so the path can't be derived from sessionId + cwd alone. We fall back
    // to the periodic backfill which discovers the file via session_meta.
    const filePath = persisted?.filePath ?? (cliTool === 'claude' ? transcriptPath(workingDir, sessionId) : '');
    log.info('Tracking session', { sessionId, cliTool, filePath });

    const session: TrackedSession = {
      sessionId,
      cliTool,
      workingDir,
      filePath,
      watching: false,
      debounceTimer: null,
      usage: persisted ? {
        sessionId,
        cliTool: (persisted.cliTool as CliToolId) || cliTool,
        inputTokens: persisted.inputTokens,
        outputTokens: persisted.outputTokens,
        cacheCreationTokens: persisted.cacheCreationTokens,
        cacheReadTokens: persisted.cacheReadTokens,
        totalCost: persisted.totalCost,
        models: persisted.models,
        messageCount: persisted.messageCount,
        firstMessageAt: persisted.firstMessageAt,
        lastMessageAt: persisted.lastMessageAt,
        parsedByteOffset: persisted.parsedByteOffset,
      } : emptySessionUsage(sessionId, cliTool),
      lastSeenModel: cliTool === 'codex' && persisted && persisted.models.length > 0
        ? persisted.models[persisted.models.length - 1].model
        : null,
    };

    this.tracked.set(sessionId, session);

    // Initial parse (Claude/Codex parse from JSONL; Crush is from SQLite)
    if (cliTool === 'claude') {
      this.parseSession(session);
      this.startWatching(session);
    } else if (cliTool === 'codex') {
      if (filePath) {
        this.parseSession(session);
        this.startWatching(session);
      }
      // No file path yet — the backfill rescan picks it up once Codex
      // writes session_meta.
    } else if (cliTool === 'opencode') {
      // For OpenCode, pull from crush.db on track and on untrack.
      // No file watching — the DB is the source of truth.
      this.refreshCrushSession(session);
    }
  }

  untrackSession(sessionId: string): void {
    const session = this.tracked.get(sessionId);
    if (!session) return;

    log.info('Untracking session', { sessionId });

    // Final parse/refresh
    if (session.cliTool === 'claude' || session.cliTool === 'codex') {
      if (session.filePath) this.parseSession(session);
    } else if (session.cliTool === 'opencode') {
      this.refreshCrushSession(session);
    }

    // Close watcher (Claude / Codex)
    this.closeWatcher(session);

    // Keep data in map for queries — don't delete
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.tracked.get(sessionId)?.usage ?? null;
  }

  getAll(): UsageInfo {
    const sessions: Record<string, SessionUsage> = {};
    let totalCost = 0;

    for (const [id, tracked] of this.tracked) {
      sessions[id] = tracked.usage;
      totalCost += tracked.usage.totalCost;
    }

    return {
      sessions,
      daily: this.buildDailyRollups(),
      totalCost,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Per-session usage rows enriched with `workingDir`. Used by the export
   * IPC; not persisted because callers of `getAll()` already have the
   * `workingDir` available via the session list when they need it for UI.
   */
  getEnrichedSessions(): Array<SessionUsage & { workingDir: string }> {
    const out: Array<SessionUsage & { workingDir: string }> = [];
    for (const tracked of this.tracked.values()) {
      out.push({ ...tracked.usage, workingDir: tracked.workingDir });
    }
    return out;
  }

  async refresh(sessionId?: string): Promise<UsageInfo> {
    const refreshOne = (session: TrackedSession): void => {
      if (session.cliTool === 'claude' || session.cliTool === 'codex') {
        if (session.filePath) this.parseSession(session);
      } else if (session.cliTool === 'opencode') {
        this.refreshCrushSession(session);
      }
    };

    if (sessionId) {
      const session = this.tracked.get(sessionId);
      if (session) refreshOne(session);
    } else {
      for (const session of this.tracked.values()) refreshOne(session);
    }
    return this.getAll();
  }

  private parseSession(session: TrackedSession): void {
    try {
      if (session.cliTool === 'codex') {
        const result = parseCodexJsonl(session.filePath, {
          startOffset: session.usage.parsedByteOffset,
          priorModel: session.lastSeenModel ?? null,
        });
        if (result.messages.length > 0 || result.newByteOffset !== session.usage.parsedByteOffset) {
          session.usage = mergeMessages(session.usage, result.messages, result.newByteOffset);
          session.lastSeenModel = result.currentModel;
          this.persistSession(session);
          this.notifyUpdate();
        } else if (result.currentModel && result.currentModel !== session.lastSeenModel) {
          session.lastSeenModel = result.currentModel;
        }
        return;
      }

      const result = parseJsonlFile(session.filePath, session.usage.parsedByteOffset);
      if (result.messages.length > 0 || result.newByteOffset !== session.usage.parsedByteOffset) {
        session.usage = mergeMessages(session.usage, result.messages, result.newByteOffset);
        this.persistSession(session);
        this.notifyUpdate();
      }
    } catch (err) {
      log.warn('Failed to parse session JSONL', {
        sessionId: session.sessionId,
        cliTool: session.cliTool,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Refresh a Crush/OpenCode session's usage data from the SQLite database.
   * This is a point-in-time read — Crush computes cost internally.
   */
  private refreshCrushSession(session: TrackedSession): void {
    const crushSessions = readCrushSessions();
    const found = crushSessions.find(cs => cs.id === session.sessionId);
    if (!found) return;

    const modelBreakdown: UsageModelBreakdown = found.model ? {
      model: found.model,
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: found.cost,
    } : {
      model: 'unknown',
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: found.cost,
    };

    session.usage = {
      sessionId: found.id,
      cliTool: 'opencode',
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: found.cost,
      models: [modelBreakdown],
      messageCount: found.messageCount,
      firstMessageAt: found.createdAt,
      lastMessageAt: found.updatedAt,
      parsedByteOffset: 0,
    };

    this.persistSession(session);
    this.notifyUpdate();
  }

  private persistSession(session: TrackedSession): void {
    const db = getDb();
    const entry: PersistedSessionUsage = {
      sessionId: session.sessionId,
      cliTool: session.cliTool,
      workingDir: session.workingDir,
      filePath: session.filePath,
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      cacheCreationTokens: session.usage.cacheCreationTokens,
      cacheReadTokens: session.usage.cacheReadTokens,
      totalCost: session.usage.totalCost,
      models: session.usage.models,
      messageCount: session.usage.messageCount,
      firstMessageAt: session.usage.firstMessageAt,
      lastMessageAt: session.usage.lastMessageAt,
      parsedByteOffset: session.usage.parsedByteOffset,
    };

    const idx = db.usageSummaries.findIndex(s => s.sessionId === session.sessionId);
    if (idx >= 0) {
      db.usageSummaries[idx] = entry;
    } else {
      db.usageSummaries.push(entry);
    }
    saveDb();
  }

  private startWatching(session: TrackedSession): void {
    // fs.watchFile polls stat(), so it handles files that don't exist yet —
    // the listener fires once the file appears and on every subsequent size
    // change. This replaces the old fs.watch + ENOENT-retry loop which gave
    // up after 60s and missed sessions where the user took longer than that
    // to send their first prompt (claude doesn't create the JSONL until then).
    if (session.watching) return;
    session.watching = true;
    fs.watchFile(session.filePath, { interval: WATCH_POLL_INTERVAL_MS, persistent: false }, (curr, prev) => {
      // File vanished or never existed yet — nothing to parse.
      if (curr.size === 0 && curr.mtimeMs === 0) return;
      // Size or mtime change → schedule a parse. An inode change (atomic
      // replace) means the file is effectively new; reset the offset so we
      // re-parse from the top.
      if (prev.ino !== 0 && curr.ino !== prev.ino) {
        session.usage.parsedByteOffset = 0;
      }
      if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) return;
      this.debouncedParse(session);
    });
  }

  private debouncedParse(session: TrackedSession): void {
    if (session.debounceTimer) clearTimeout(session.debounceTimer);
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;
      this.parseSession(session);
    }, WATCH_DEBOUNCE_MS);
  }

  private closeWatcher(session: TrackedSession): void {
    if (session.watching) {
      fs.unwatchFile(session.filePath);
      session.watching = false;
    }
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }
  }

  private buildDailyRollups(): DailyUsage[] {
    const dayMap = new Map<string, DailyUsage>();

    for (const tracked of this.tracked.values()) {
      const u = tracked.usage;
      if (!u.lastMessageAt) continue;

      const date = u.lastMessageAt.slice(0, 10); // YYYY-MM-DD
      const day = dayMap.get(date) || {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0,
        sessionCount: 0,
      };

      day.inputTokens += u.inputTokens;
      day.outputTokens += u.outputTokens;
      day.cacheCreationTokens += u.cacheCreationTokens;
      day.cacheReadTokens += u.cacheReadTokens;
      day.totalCost += u.totalCost;
      day.sessionCount++;
      dayMap.set(date, day);
    }

    return Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  private notifyUpdate(): void {
    this.callback?.(this.getAll());
  }

  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const session of this.tracked.values()) {
      this.closeWatcher(session);
    }
    log.info('Usage service stopped');
  }

  dispose(): void {
    this.stop();
    this.tracked.clear();
  }
}

export const usageService = new UsageService();
