import * as fs from 'node:fs';
import { createLogger } from '../logger';
import { transcriptPath, scanAllTranscripts } from '../claude/transcripts';
import { parseJsonlFile, type ParsedMessage } from './jsonl-parser';
import { getDb, saveDb, type PersistedSessionUsage } from '../db/database';
import type { SessionUsage, UsageModelBreakdown, UsageInfo, DailyUsage } from '../../shared/types';

const log = createLogger('usage');

const WATCH_DEBOUNCE_MS = 300;
const WATCH_POLL_INTERVAL_MS = 2_000;
const RESCAN_INTERVAL_MS = 5 * 60 * 1_000;

interface TrackedSession {
  claudeSessionId: string;
  workingDir: string;
  filePath: string;
  watching: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  usage: SessionUsage;
}

function emptySessionUsage(claudeSessionId: string): SessionUsage {
  return {
    claudeSessionId,
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
    claudeSessionId: existing.claudeSessionId,
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
      if (!this.tracked.has(summary.claudeSessionId)) {
        this.tracked.set(summary.claudeSessionId, {
          claudeSessionId: summary.claudeSessionId,
          workingDir: summary.workingDir,
          filePath: summary.filePath ?? transcriptPath(summary.workingDir, summary.claudeSessionId),
          watching: false,
          debounceTimer: null,
          usage: {
            claudeSessionId: summary.claudeSessionId,
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
   */
  private backfillFromDisk(): void {
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
          claudeSessionId: d.sessionId,
          workingDir: d.projectDirName,
          filePath: d.filePath,
          watching: false,
          debounceTimer: null,
          usage: emptySessionUsage(d.sessionId),
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

    if (newSessions > 0 || updatedSessions > 0) {
      log.info('Transcript scan complete', {
        total: discovered.length,
        newSessions,
        updatedSessions,
      });
      this.notifyUpdate();
    }
  }

  trackSession(claudeSessionId: string, workingDir: string): void {
    const existing = this.tracked.get(claudeSessionId);
    if (existing) {
      // start() pre-loads DB summaries into `tracked` without a watcher,
      // so a subsequent trackSession from session:create used to silently
      // skip the watcher. Make sure one is attached.
      if (!existing.watching) this.startWatching(existing);
      return;
    }

    // Check for persisted data
    const db = getDb();
    const persisted = db.usageSummaries.find(s => s.claudeSessionId === claudeSessionId);

    // Prefer the authoritative filePath from a scan-discovered summary —
    // its workingDir is the encoded project dir name, which is lossy to
    // recover into a real path. transcriptPath() is correct for fresh
    // Tether sessions where workingDir is the actual cwd.
    const filePath = persisted?.filePath ?? transcriptPath(workingDir, claudeSessionId);
    log.info('Tracking session', { claudeSessionId, filePath });

    const session: TrackedSession = {
      claudeSessionId,
      workingDir,
      filePath,
      watching: false,
      debounceTimer: null,
      usage: persisted ? {
        claudeSessionId,
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
      } : emptySessionUsage(claudeSessionId),
    };

    this.tracked.set(claudeSessionId, session);

    // Initial parse
    this.parseSession(session);

    // Start watching
    this.startWatching(session);
  }

  untrackSession(claudeSessionId: string): void {
    const session = this.tracked.get(claudeSessionId);
    if (!session) return;

    log.info('Untracking session', { claudeSessionId });

    // Final parse
    this.parseSession(session);

    // Close watcher
    this.closeWatcher(session);

    // Keep data in map for queries — don't delete
  }

  getSessionUsage(claudeSessionId: string): SessionUsage | null {
    return this.tracked.get(claudeSessionId)?.usage ?? null;
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

  async refresh(claudeSessionId?: string): Promise<UsageInfo> {
    if (claudeSessionId) {
      const session = this.tracked.get(claudeSessionId);
      if (session) this.parseSession(session);
    } else {
      for (const session of this.tracked.values()) {
        this.parseSession(session);
      }
    }
    return this.getAll();
  }

  private parseSession(session: TrackedSession): void {
    try {
      const result = parseJsonlFile(session.filePath, session.usage.parsedByteOffset);
      if (result.messages.length > 0 || result.newByteOffset !== session.usage.parsedByteOffset) {
        session.usage = mergeMessages(session.usage, result.messages, result.newByteOffset);
        this.persistSession(session);
        this.notifyUpdate();
      }
    } catch (err) {
      log.warn('Failed to parse session JSONL', {
        claudeSessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persistSession(session: TrackedSession): void {
    const db = getDb();
    const entry: PersistedSessionUsage = {
      claudeSessionId: session.claudeSessionId,
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

    const idx = db.usageSummaries.findIndex(s => s.claudeSessionId === session.claudeSessionId);
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
