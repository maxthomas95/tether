import * as fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
import { transcriptPath, scanAllTranscripts } from '../claude/transcripts';
import { scanAllCodexTranscripts } from '../codex/transcripts';
import { parseJsonlFile, parseClaudeUsageText, type ParsedMessage } from './jsonl-parser';
import { parseCodexJsonl, parseCodexUsageText, type CodexTokenUsageCounters, type CodexRequestUsageCheckpoint } from './codex-jsonl-parser';
import { readCrushSessions } from '../opencode/usage-reader';
import { readNativeOpenCodeUsage } from '../opencode/native-usage-reader';
import { NativeOpenCodeUsageSource, openCodeUsageContext, type OpenCodeUsageContext } from '../opencode/native-usage-source';
import { getDb, saveDb, type PersistedSessionUsage } from '../db/database';
import { aggregateByEnvironment } from './env-aggregator';
import { aggregateByCliTool } from './cli-tool-aggregator';
import type {
  SessionUsage,
  UsageModelBreakdown,
  UsageInfo,
  DailyUsage,
  DailyCliToolUsage,
  SessionDailyUsage,
  CliToolId,
} from '../../shared/types';

import type { RemoteUsageCli, RemoteUsageReply, RemoteUsageSource } from './remote-protocol';

const log = createLogger('usage');

const WATCH_DEBOUNCE_MS = 300;
const WATCH_POLL_INTERVAL_MS = 2_000;
const RESCAN_INTERVAL_MS = 5 * 60 * 1_000;
const USAGE_SCHEMA_VERSION = 2;
const CODEX_USAGE_SCHEMA_VERSION = 3;

function usageSchemaVersion(cliTool: string): number {
  return cliTool === 'codex' ? CODEX_USAGE_SCHEMA_VERSION : USAGE_SCHEMA_VERSION;
}

interface TrackedSession {
  remote?: RemoteUsageSource;
  remoteNeedsReparse?: boolean;
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
  codexTokenUsage?: CodexTokenUsageCounters | null;
  codexRequestUsage?: CodexRequestUsageCheckpoint | null;
}

interface NativeUsageCandidate {
  snapshot: SessionUsage;
  dbPath: string;
}

function normalizeNativePath(value: string): string {
  return process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
}

function emptySessionUsage(sessionId: string, cliTool: CliToolId, environmentId?: string): SessionUsage {
  return {
    sessionId,
    cliTool,
    environmentId,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    models: [],
    daily: [],
    dayTiming: 'event',
    contextUsedTokens: null,
    observedAt: null,
    currentModel: null,
    currentReasoningEffort: null,
    contextWindowTokens: null,
    messageCount: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    parsedByteOffset: 0,
  };
}

export function resetUsageForReparse(existing: SessionUsage): SessionUsage {
  return {
    ...emptySessionUsage(existing.sessionId, existing.cliTool, existing.environmentId),
    workingDir: existing.workingDir,
    dayTiming: existing.cliTool === 'opencode' ? 'snapshot' : 'event',
  };
}

function hydrateUsage(summary: PersistedSessionUsage, cliTool: CliToolId, environmentId?: string): SessionUsage {
  return {
    sessionId: summary.sessionId,
    cliTool,
    costSource: summary.costSource ?? (cliTool === 'opencode' ? 'reported' : undefined),
    usageSource: summary.usageSource ?? (cliTool === 'opencode' ? 'crush' : undefined),
    collectionStatus: summary.usageSource === 'native-opencode' ? 'unavailable' : undefined,
    environmentId: summary.environmentId ?? environmentId,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    reasoningTokens: summary.reasoningTokens ?? 0,
    cacheCreationTokens: summary.cacheCreationTokens,
    cacheReadTokens: summary.cacheReadTokens,
    totalCost: summary.totalCost,
    models: summary.models.map(cloneModelBreakdown),
    daily: summary.daily?.map(cloneDailyUsage) ?? [],
    dayTiming: summary.dayTiming ?? ((summary.daily?.length ?? 0) > 0 ? 'event' : undefined),
    workingDir: summary.workingDir,
    contextUsedTokens: summary.contextUsedTokens ?? null,
    observedAt: summary.observedAt ?? null,
    currentModel: summary.currentModel ?? null,
    currentReasoningEffort: summary.currentReasoningEffort ?? null,
    contextWindowTokens: summary.contextWindowTokens ?? null,
    messageCount: summary.messageCount,
    firstMessageAt: summary.firstMessageAt,
    lastMessageAt: summary.lastMessageAt,
    parsedByteOffset: summary.parsedByteOffset,
  };
}

function needsUsageReparse(summary: PersistedSessionUsage, filePath: string): boolean {
  return summary.usageSchemaVersion !== usageSchemaVersion(summary.cliTool)
    && summary.cliTool !== 'opencode'
    && !!filePath
    && fs.existsSync(filePath);
}

function needsTrackedUsageReparse(usage: SessionUsage, filePath: string): boolean {
  return usage.dayTiming === 'legacy'
    && usage.cliTool !== 'opencode'
    && !!filePath
    && fs.existsSync(filePath);
}

function markLegacyIfTranscriptUnavailable(usage: SessionUsage, filePath: string): SessionUsage {
  if (usage.dayTiming || usage.daily?.length) return usage;
  if (filePath && fs.existsSync(filePath)) return usage;
  return { ...usage, daily: [], dayTiming: 'legacy' };
}

function cloneModelBreakdown(model: UsageModelBreakdown): UsageModelBreakdown {
  return {
    ...model,
    reasoningTokens: model.reasoningTokens ?? 0,
  };
}

function emptyModelBreakdown(model: string): UsageModelBreakdown {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
}

function messageDate(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function cloneDailyUsage(day: SessionDailyUsage): SessionDailyUsage {
  return {
    ...day,
    reasoningTokens: day.reasoningTokens ?? 0,
    models: day.models.map(cloneModelBreakdown),
  };
}

function addMessageToBreakdown(modelMap: Map<string, UsageModelBreakdown>, msg: ParsedMessage): void {
  const mb = modelMap.get(msg.model) || emptyModelBreakdown(msg.model);
  mb.inputTokens += msg.inputTokens;
  mb.outputTokens += msg.outputTokens;
  mb.reasoningTokens = (mb.reasoningTokens ?? 0) + (msg.reasoningTokens ?? 0);
  mb.cacheCreationTokens += msg.cacheCreation5m + msg.cacheCreation1h;
  mb.cacheReadTokens += msg.cacheReadTokens;
  mb.cost += msg.cost;
  modelMap.set(msg.model, mb);
}

export function mergeMessages(existing: SessionUsage, messages: ParsedMessage[], newOffset: number): SessionUsage {
  if (messages.length === 0) return { ...existing, parsedByteOffset: newOffset };

  // Accumulate model breakdowns
  const modelMap = new Map<string, UsageModelBreakdown>();
  for (const m of existing.models) {
    modelMap.set(m.model, cloneModelBreakdown(m));
  }

  const dailyMap = new Map<string, SessionDailyUsage>();
  for (const d of existing.daily ?? []) {
    dailyMap.set(d.date, cloneDailyUsage(d));
  }

  let { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost, messageCount } = existing;
  let reasoningTokens = existing.reasoningTokens ?? 0;
  let firstMessageAt = existing.firstMessageAt;
  let lastMessageAt = existing.lastMessageAt;
  let currentModel = existing.currentModel ?? null;

  for (const msg of messages) {
    inputTokens += msg.inputTokens;
    outputTokens += msg.outputTokens;
    reasoningTokens += msg.reasoningTokens ?? 0;
    cacheCreationTokens += msg.cacheCreation5m + msg.cacheCreation1h;
    cacheReadTokens += msg.cacheReadTokens;
    totalCost += msg.cost;
    messageCount++;
    currentModel = msg.model;

    if (!firstMessageAt || msg.timestamp < firstMessageAt) {
      firstMessageAt = msg.timestamp;
    }
    if (!lastMessageAt || msg.timestamp > lastMessageAt) {
      lastMessageAt = msg.timestamp;
    }

    addMessageToBreakdown(modelMap, msg);

    const date = messageDate(msg.timestamp);
    const daily = dailyMap.get(date) || {
      date,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      messageCount: 0,
      models: [],
    };
    daily.inputTokens += msg.inputTokens;
    daily.outputTokens += msg.outputTokens;
    daily.reasoningTokens = (daily.reasoningTokens ?? 0) + (msg.reasoningTokens ?? 0);
    daily.cacheCreationTokens += msg.cacheCreation5m + msg.cacheCreation1h;
    daily.cacheReadTokens += msg.cacheReadTokens;
    daily.totalCost += msg.cost;
    daily.messageCount++;
    const dailyModelMap = new Map<string, UsageModelBreakdown>(daily.models.map(m => [m.model, cloneModelBreakdown(m)]));
    addMessageToBreakdown(dailyModelMap, msg);
    daily.models = Array.from(dailyModelMap.values());
    dailyMap.set(date, daily);
  }

  return {
    sessionId: existing.sessionId,
    cliTool: existing.cliTool,
    environmentId: existing.environmentId,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalCost,
    models: Array.from(modelMap.values()),
    daily: Array.from(dailyMap.values()).sort((a, b) => b.date.localeCompare(a.date)),
    currentModel,
    currentReasoningEffort: existing.currentReasoningEffort ?? null,
    contextWindowTokens: existing.contextWindowTokens ?? null,
    messageCount,
    firstMessageAt,
    lastMessageAt,
    parsedByteOffset: newOffset,
  };
}

// Invalid resume metadata must not create a watcher or abort session startup.
function claudeUsagePath(workingDir: string, sessionId: string): string {
  try {
    return transcriptPath(workingDir, sessionId);
  } catch {
    return '';
  }
}

function sameNativeMeasurement(a: SessionUsage, b: SessionUsage): boolean {
  const measurement = (usage: SessionUsage) => {
    const { observedAt: _observedAt, collectionStatus: _status, environmentId: _env, workingDir: _cwd, ...values } = usage;
    return JSON.stringify(values);
  };
  return measurement(a) === measurement(b);
}

export class UsageService {
  private tracked = new Map<string, TrackedSession>();
  private callback: ((info: UsageInfo) => void) | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly nativeSource = new NativeOpenCodeUsageSource();
  private readonly nativeContexts = new Map<string, OpenCodeUsageContext>();
  private nativePoll: ReturnType<typeof setInterval> | null = null;
  private nativeRefresh: Promise<void> | null = null;
  private nativeGeneration = 0;
  private nativeRevision = 0;
  private stopped = false;
  private backfillTask: ReturnType<typeof setImmediate> | null = null;

  onUpdate(cb: (info: UsageInfo) => void): void {
    this.callback = cb;
  }

  start(): void {
    this.stopped = false;
    this.nativeGeneration++;
    log.info('Usage service started');
    // Load persisted summaries into memory
    const db = getDb();
    for (const summary of db.usageSummaries) {
      if (!this.tracked.has(summary.sessionId)) {
        const cliTool = (summary.cliTool as CliToolId) || 'claude';
        const filePath = summary.remote ? '' : summary.filePath ?? (cliTool === 'claude' ? claudeUsagePath(summary.workingDir, summary.sessionId) : '');
        const usage = markLegacyIfTranscriptUnavailable(hydrateUsage(summary, cliTool), filePath);
        this.tracked.set(summary.sessionId, {
          sessionId: summary.sessionId,
          cliTool,
          workingDir: summary.workingDir,
          filePath,
          remote: summary.remote,
          remoteNeedsReparse: !!summary.remote && summary.usageSchemaVersion !== usageSchemaVersion(cliTool),
          watching: false,
          debounceTimer: null,
          usage,
          lastSeenModel: summary.remote ? usage.currentModel ?? summary.lastSeenModel ?? null : usage.dayTiming === 'legacy' ? null : usage.currentModel ?? null,
          codexTokenUsage: summary.codexTokenUsage ?? null,
          codexRequestUsage: summary.codexRequestUsage ?? null,
        });
        const tracked = this.tracked.get(summary.sessionId);
        if (tracked && needsUsageReparse(summary, filePath)) {
          this.reparseSessionPreservingLegacy(tracked);
        } else if (usage.dayTiming === 'legacy' && usage.dayTiming !== summary.dayTiming) {
          this.persistSession(this.tracked.get(summary.sessionId)!, false);
        }
      }
    }

    // Non-blocking backfill of any sessions we don't know about yet. The
    // event loop keeps the UI responsive while we chew through historical
    // JSONLs. Afterwards, a periodic rescan catches appends to historical
    // files from out-of-band claude runs.
    this.backfillTask = setImmediate(() => {
      this.backfillTask = null;
      if (!this.stopped) this.backfillFromDisk();
    });
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
    if (this.stopped) return;
    // 1. Backfill Claude Code transcripts (JSONL)
    let discovered: ReturnType<typeof scanAllTranscripts>;
    try {
      discovered = scanAllTranscripts();
    } catch (err) {
      log.warn('Transcript scan failed', { error: err instanceof Error ? err.message : String(err) });
      discovered = [];
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
      existing.filePath = d.filePath;
      if (!existing.watching) this.startWatching(existing);
      if (needsTrackedUsageReparse(existing.usage, existing.filePath)) {
        this.reparseSessionPreservingLegacy(existing);
        updatedSessions++;
        continue;
      }
      // Already known. Re-parse if the file grew; if it shrank, reset the full
      // accumulator first so a replacement/truncation cannot double-count.
      if (d.size < existing.usage.parsedByteOffset) {
        this.reparseSessionPreservingLegacy(existing);
        updatedSessions++;
      } else if (d.size > existing.usage.parsedByteOffset) {
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
      existing.workingDir = d.cwd;
      existing.filePath = d.filePath;
      existing.usage.workingDir = d.cwd;
      if (!existing.watching) this.startWatching(existing);
      if (needsTrackedUsageReparse(existing.usage, existing.filePath)) {
        this.reparseSessionPreservingLegacy(existing);
        updatedSessions++;
        continue;
      }
      if (d.size < existing.usage.parsedByteOffset) {
        this.reparseSessionPreservingLegacy(existing);
        updatedSessions++;
      } else if (d.size > existing.usage.parsedByteOffset) {
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
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: cs.cost,
        } : {
          model: 'unknown',
          inputTokens: cs.promptTokens,
          outputTokens: cs.completionTokens,
          reasoningTokens: 0,
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
            usageSource: 'crush',
            costSource: 'reported',
            collectionStatus: 'available',
            inputTokens: cs.promptTokens,
            outputTokens: cs.completionTokens,
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: cs.cost,
            models: [modelBreakdown],
            dayTiming: 'snapshot',
            workingDir: cs.directory,
            contextUsedTokens: null,
            observedAt: cs.updatedAt,
            daily: [{
              date: messageDate(cs.updatedAt),
              inputTokens: cs.promptTokens,
              outputTokens: cs.completionTokens,
              reasoningTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalCost: cs.cost,
              messageCount: cs.messageCount,
              models: [modelBreakdown],
            }],
            currentModel: modelBreakdown.model,
            currentReasoningEffort: null,
            contextWindowTokens: null,
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
    void this.refreshNativeOpenCode();
  }

  trackSession(sessionId: string, workingDir: string, cliTool: CliToolId = 'claude', environmentId?: string, context?: OpenCodeUsageContext): void {
    const existing = this.tracked.get(sessionId);
    if (existing) {
      this.refreshExistingTrackedSession(existing, workingDir, cliTool, environmentId, context);
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
    const filePath = persisted?.filePath ?? (cliTool === 'claude' ? claudeUsagePath(workingDir, sessionId) : '');
    const sessionUsage = persisted ? {
      ...markLegacyIfTranscriptUnavailable(hydrateUsage(persisted, (persisted.cliTool as CliToolId) || cliTool, environmentId), filePath),
      workingDir,
    } : { ...emptySessionUsage(sessionId, cliTool, environmentId), workingDir };
    log.info('Tracking session', { sessionId, cliTool, filePath, environmentId: environmentId ?? null });

    const session: TrackedSession = {
      sessionId,
      cliTool,
      workingDir,
      filePath,
      watching: false,
      debounceTimer: null,
      usage: sessionUsage,
      lastSeenModel: cliTool === 'codex' && persisted && sessionUsage.dayTiming !== 'legacy'
        ? persisted.currentModel ?? null
        : null,
    };

    this.tracked.set(sessionId, session);
    session.codexTokenUsage = persisted?.codexTokenUsage ?? null;
    session.codexRequestUsage = persisted?.codexRequestUsage ?? null;
    if (persisted && needsUsageReparse(persisted, filePath)) {
      this.reparseSessionPreservingLegacy(session);
    }

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
      this.activateOpenCode(session, context);
    }
  }

  private refreshExistingTrackedSession(existing: TrackedSession, workingDir: string, cliTool: CliToolId, environmentId?: string, context?: OpenCodeUsageContext): void {
    let changed = false;
    if (workingDir && existing.workingDir !== workingDir) {
      existing.workingDir = workingDir;
      existing.usage.workingDir = workingDir;
      changed = true;
    }
    // Persisted summaries are loaded without watchers. Reattach known local
    // transcript paths when a session is activated after startup.
    if (!existing.watching && existing.filePath && (existing.cliTool === 'claude' || existing.cliTool === 'codex')) {
      this.startWatching(existing);
    }
    // Backfill can discover the conversation before its environment is known.
    if (environmentId && !existing.usage.environmentId) {
      existing.usage.environmentId = environmentId;
      changed = true;
    }
    if (needsTrackedUsageReparse(existing.usage, existing.filePath)) {
      this.reparseSessionPreservingLegacy(existing);
      this.notifyUpdate();
    } else if (changed) {
      this.persistSession(existing);
      this.notifyUpdate();
    }
    if (cliTool === 'opencode' && !existing.remote) this.activateOpenCode(existing, context);
  }

  /** Restore a remote cursor without ever opening/watching its path locally. */
  trackRemote(sessionId: string, workingDir: string, cliTool: RemoteUsageCli, environmentId: string, remote: RemoteUsageSource): { offset: number; identity: string } {
    let session = this.tracked.get(sessionId);
    if (!session) {
      const saved = getDb().usageSummaries.find(s => s.sessionId === sessionId && s.remote);
      const usage = saved
        ? markLegacyIfTranscriptUnavailable(hydrateUsage(saved, cliTool, environmentId), '')
        : emptySessionUsage(sessionId, cliTool, environmentId);
      session = { sessionId, cliTool, workingDir, filePath: '', watching: false, debounceTimer: null,
        remote: saved?.remote ?? remote, usage, lastSeenModel: saved?.currentModel ?? saved?.lastSeenModel ?? null,
        codexTokenUsage: saved?.codexTokenUsage ?? null,
        codexRequestUsage: saved?.codexRequestUsage ?? null,
        remoteNeedsReparse: !!saved && saved.usageSchemaVersion !== usageSchemaVersion(cliTool) };
      this.tracked.set(sessionId, session);
    }
    if (session.remoteNeedsReparse) return { offset: 0, identity: '' };
    return { offset: session.usage.parsedByteOffset, identity: session.remote?.identity ?? '' };
  }

  applyRemote(sessionId: string, reply: RemoteUsageReply): void {
    const session = this.tracked.get(sessionId);
    if (!session?.remote || !reply.source || reply.offset === undefined || reply.text === undefined) return;
    if (!session.remoteNeedsReparse && !reply.reset && reply.offset <= session.usage.parsedByteOffset) return;
    if (reply.reset || session.remoteNeedsReparse) this.resetTrackedSessionForReparse(session);
    const codexResult = session.cliTool === 'codex'
      ? parseCodexUsageText(reply.text, {
        startOffset: 0, priorModel: session.lastSeenModel ?? null,
        priorReasoningEffort: session.usage.currentReasoningEffort,
        priorContextWindowTokens: session.usage.contextWindowTokens,
        priorContextUsedTokens: session.usage.contextUsedTokens,
        priorTokenUsage: session.codexTokenUsage,
        nativeSessionId: session.remote.nativeSessionId,
        priorRequestUsage: session.codexRequestUsage,
      })
      : null;
    const parsed = codexResult ?? parseClaudeUsageText(reply.text);
    // Sanitized text has a different byte length. The cursor always refers to
    // the remote original and advances across non-usage records as well.
    session.usage = mergeMessages(session.usage, parsed.messages, reply.offset);
    session.usage.dayTiming = 'event';
    session.usage.workingDir = session.workingDir;
    if (codexResult) {
      session.lastSeenModel = codexResult.currentModel;
      session.codexTokenUsage = codexResult.tokenUsage;
      session.codexRequestUsage = codexResult.requestUsage;
      session.usage.currentModel = codexResult.currentModel;
      session.usage.currentReasoningEffort = codexResult.currentReasoningEffort;
      session.usage.contextWindowTokens = codexResult.contextWindowTokens;
      session.usage.contextUsedTokens = codexResult.contextUsedTokens;
      session.usage.observedAt = codexResult.observedAt ?? session.usage.observedAt ?? null;
    } else {
      session.usage.observedAt = parsed.messages.at(-1)?.timestamp ?? session.usage.observedAt ?? null;
    }
    session.remoteNeedsReparse = false;
    session.remote = reply.source;
    this.persistSession(session);
    this.notifyUpdate();
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
      const context = this.nativeContexts.get(sessionId);
      void this.refreshNativeOpenCode().finally(() => {
        // A new launch may have reactivated this ID while the final read ran.
        if (this.nativeContexts.get(sessionId) !== context) return;
        if (this.nativeContexts.delete(sessionId)) this.nativeRevision++;
        if (this.nativeContexts.size === 0 && this.nativePoll) {
          clearInterval(this.nativePoll);
          this.nativePoll = null;
        }
      });
    }

    // Close watcher (Claude / Codex)
    this.closeWatcher(session);

    // Keep data in map for queries — don't delete
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.tracked.get(sessionId)?.usage ?? null;
  }

  /** Main-process side channels only; remote transcript paths are never local files. */
  getLocalTranscriptPath(sessionId: string): string | null {
    const tracked = this.tracked.get(sessionId);
    return tracked && !tracked.remote && (tracked.cliTool === 'claude' || tracked.cliTool === 'codex') && tracked.filePath ? tracked.filePath : null;
  }

  getAll(): UsageInfo {
    const sessions: Record<string, SessionUsage> = {};
    const allUsage: SessionUsage[] = [];
    let totalCost = 0;

    for (const [id, tracked] of this.tracked) {
      const usage = { ...tracked.usage, workingDir: tracked.workingDir };
      sessions[id] = usage;
      if (usage.collectionStatus === 'unavailable' && !usage.observedAt) continue;
      allUsage.push(usage);
      totalCost += tracked.usage.totalCost;
    }

    return {
      sessions,
      daily: this.buildDailyRollups(),
      byEnvironment: aggregateByEnvironment(allUsage),
      byCliTool: aggregateByCliTool(allUsage),
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
      if (tracked.usage.collectionStatus === 'unavailable' && !tracked.usage.observedAt) continue;
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
    if (!sessionId || this.tracked.get(sessionId)?.cliTool === 'opencode') await this.refreshNativeOpenCode();
    return this.getAll();
  }

  private parseSession(session: TrackedSession): boolean {
    if (session.remote || !session.filePath) return false;
    try {
      if (session.cliTool === 'codex') {
        const result = parseCodexJsonl(session.filePath, {
          startOffset: session.usage.parsedByteOffset,
          priorModel: session.lastSeenModel ?? null,
          priorReasoningEffort: session.usage.currentReasoningEffort ?? null,
          priorContextWindowTokens: session.usage.contextWindowTokens ?? null,
          priorContextUsedTokens: session.usage.contextUsedTokens ?? null,
          priorTokenUsage: session.codexTokenUsage ?? null,
          nativeSessionId: session.sessionId,
          priorRequestUsage: session.codexRequestUsage ?? null,
        });
        if (result.messages.length > 0 || result.newByteOffset !== session.usage.parsedByteOffset) {
          session.usage = mergeMessages(session.usage, result.messages, result.newByteOffset);
          session.lastSeenModel = result.currentModel;
          session.codexTokenUsage = result.tokenUsage;
          session.codexRequestUsage = result.requestUsage;
          session.usage.dayTiming = 'event';
          session.usage.workingDir = session.workingDir;
          session.usage.currentModel = result.currentModel ?? session.usage.currentModel ?? null;
          session.usage.currentReasoningEffort = result.currentReasoningEffort;
          session.usage.contextWindowTokens = result.contextWindowTokens;
          session.usage.contextUsedTokens = result.contextUsedTokens;
          session.usage.observedAt = result.observedAt ?? session.usage.observedAt ?? null;
          this.persistSession(session);
          this.notifyUpdate();
          return true;
        } else if (
          (result.currentModel && result.currentModel !== session.lastSeenModel)
          || result.currentReasoningEffort !== session.usage.currentReasoningEffort
          || result.contextWindowTokens !== session.usage.contextWindowTokens
          || result.contextUsedTokens !== session.usage.contextUsedTokens
          || (result.observedAt !== null && result.observedAt !== session.usage.observedAt)
          || result.tokenUsage !== session.codexTokenUsage
          || result.requestUsage !== session.codexRequestUsage
        ) {
          session.lastSeenModel = result.currentModel;
          session.codexTokenUsage = result.tokenUsage;
          session.codexRequestUsage = result.requestUsage;
          session.usage.currentModel = result.currentModel;
          session.usage.currentReasoningEffort = result.currentReasoningEffort;
          session.usage.contextWindowTokens = result.contextWindowTokens;
          session.usage.contextUsedTokens = result.contextUsedTokens;
          session.usage.observedAt = result.observedAt ?? session.usage.observedAt ?? null;
          this.persistSession(session);
          return true;
        }
        return false;
      }

      const result = parseJsonlFile(session.filePath, session.usage.parsedByteOffset);
      if (result.messages.length > 0 || result.newByteOffset !== session.usage.parsedByteOffset) {
        session.usage = mergeMessages(session.usage, result.messages, result.newByteOffset);
        session.usage.dayTiming = 'event';
        session.usage.workingDir = session.workingDir;
        session.usage.observedAt = result.messages[result.messages.length - 1]?.timestamp ?? session.usage.observedAt ?? null;
        this.persistSession(session);
        this.notifyUpdate();
        return true;
      }
      return false;
    } catch (err) {
      log.warn('Failed to parse session JSONL', {
        sessionId: session.sessionId,
        cliTool: session.cliTool,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private activateOpenCode(session: TrackedSession, context?: OpenCodeUsageContext): void {
    if (this.stopped) return;
    this.refreshCrushSession(session);
    if (session.usage.usageSource === 'crush') return;
    const previous = this.nativeContexts.get(session.sessionId);
    const next = context
      ? openCodeUsageContext(session.workingDir, context.env)
      : previous ?? openCodeUsageContext(session.workingDir);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.nativeRevision++;
      if (this.markNativeUnavailable(session.sessionId)) this.notifyUpdate();
    }
    this.nativeContexts.set(session.sessionId, { ...next });
    if (!this.nativePoll) {
      this.nativePoll = setInterval(() => { void this.refreshNativeOpenCode(); }, 10_000);
      this.nativePoll.unref?.();
    }
    void this.refreshNativeOpenCode();
  }

  private refreshNativeOpenCode(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.nativeRefresh) return this.nativeRefresh;
    const generation = this.nativeGeneration;
    const request = this.collectCurrentNativeOpenCode(generation).catch(() => {
      if (generation !== this.nativeGeneration) return;
      log.warn('Native OpenCode usage collection unavailable');
      for (const id of this.nativeContexts.keys()) this.markNativeUnavailable(id);
      this.notifyUpdate();
    }).finally(() => {
      if (this.nativeRefresh === request) this.nativeRefresh = null;
    });
    this.nativeRefresh = request;
    return request;
  }

  private collectCurrentNativeOpenCode(generation: number): Promise<void> {
    const revision = this.nativeRevision;
    return this.collectNativeOpenCode(generation, revision).then(() => {
      if (generation === this.nativeGeneration && revision !== this.nativeRevision) {
        return this.collectCurrentNativeOpenCode(generation);
      }
    });
  }

  private markNativeUnavailable(id: string): boolean {
    const session = this.tracked.get(id);
    if (!session || session.remote || session.cliTool !== 'opencode' || session.usage.usageSource === 'crush') return false;
    const changed = session.usage.collectionStatus !== 'unavailable';
    session.usage.collectionStatus = 'unavailable';
    return changed;
  }

  private async collectNativeOpenCode(generation: number, revision: number): Promise<void> {
    const { expected, sources } = await this.discoverNativeSources();
    if (generation !== this.nativeGeneration || revision !== this.nativeRevision) return;
    const failed = new Set<string>([...expected].filter(([, value]) => value === null).map(([id]) => id));
    const candidates = new Map<string, NativeUsageCandidate[]>();
    for (const [sourceKey, dbPath] of sources) this.readNativeSource(sourceKey, dbPath, expected, candidates, failed);
    let changed = false;
    for (const [id, entries] of candidates) {
      if (entries.length !== 1 || failed.has(id)) {
        // Do not persist an arbitrary source for an ambiguous unowned ID.
        if (!this.tracked.has(id)) {
          this.tracked.set(id, { sessionId: id, cliTool: 'opencode', workingDir: '', filePath: '',
            watching: false, debounceTimer: null, usage: emptySessionUsage(id, 'opencode') });
        }
        failed.add(id);
        continue;
      }
      changed = this.applyNativeSnapshot(entries[0].snapshot, entries[0].dbPath) || changed;
    }
    for (const id of failed) changed = this.markNativeUnavailable(id) || changed;
    if (changed) this.notifyUpdate();
  }

  private async discoverNativeSources(): Promise<{ expected: Map<string, string | null>; sources: Map<string, string> }> {
    const active = [...this.nativeContexts.entries()];
    const paths = await Promise.all([
      this.nativeSource.resolvePath(),
      ...active.map(([, context]) => this.nativeSource.resolvePath(context)),
    ]);
    const expected = new Map<string, string | null>();
    const sources = new Map<string, string>();
    const addSource = (value: string | null) => { if (value) sources.set(normalizeNativePath(value), value); };
    paths.forEach(addSource);
    active.forEach(([id], index) => expected.set(id, paths[index + 1] ? normalizeNativePath(paths[index + 1]!) : null));
    for (const session of this.tracked.values()) {
      if (session.remote || session.usage.usageSource !== 'native-opencode' || !session.filePath) continue;
      addSource(session.filePath);
    }
    return { expected, sources };
  }

  private readNativeSource(sourceKey: string, dbPath: string, expected: Map<string, string | null>, candidates: Map<string, NativeUsageCandidate[]>, failed: Set<string>): void {
    const result = readNativeOpenCodeUsage(dbPath);
    const returned = new Set(result.status === 'available' ? result.sessions.map(session => session.sessionId) : []);
    this.markMissingNativeSessions(sourceKey, expected, returned, failed);
    if (result.status !== 'available') return;
    for (const id of result.unavailableSessionIds) {
      if (!expected.has(id) || expected.get(id) === sourceKey) failed.add(id);
    }
    for (const snapshot of result.sessions) {
      if (expected.has(snapshot.sessionId) && expected.get(snapshot.sessionId) !== sourceKey) continue;
      const entries = candidates.get(snapshot.sessionId) ?? [];
      entries.push({ snapshot, dbPath });
      candidates.set(snapshot.sessionId, entries);
    }
  }

  private markMissingNativeSessions(sourceKey: string, expected: Map<string, string | null>, returned: Set<string>, failed: Set<string>): void {
    for (const [id, source] of expected) {
      if (source === sourceKey && !returned.has(id)) failed.add(id);
    }
    for (const session of this.tracked.values()) {
      if (!expected.has(session.sessionId) && session.usage.usageSource === 'native-opencode'
        && normalizeNativePath(session.filePath) === sourceKey && !returned.has(session.sessionId)) failed.add(session.sessionId);
    }
  }

  private applyNativeSnapshot(snapshot: SessionUsage, dbPath: string): boolean {
    const existing = this.tracked.get(snapshot.sessionId);
    if (existing && (existing.remote || existing.cliTool !== 'opencode' || existing.usage.usageSource === 'crush')) return false;
    const session: TrackedSession = existing ?? {
      sessionId: snapshot.sessionId, cliTool: 'opencode', workingDir: snapshot.workingDir ?? '',
      filePath: dbPath, watching: false, debounceTimer: null, usage: snapshot,
    };
    const next = { ...snapshot, environmentId: existing?.usage.environmentId };
    const needsSave = !existing || session.filePath !== dbPath || !sameNativeMeasurement(session.usage, next);
    const changed = needsSave || session.usage.collectionStatus !== 'available';
    session.usage = next;
    session.filePath = dbPath;
    if (!session.workingDir) session.workingDir = snapshot.workingDir ?? '';
    this.tracked.set(snapshot.sessionId, session);
    if (needsSave) this.persistSession(session);
    return changed;
  }

  /**
   * Refresh a legacy Crush session's usage data from the SQLite database.
   * This is a point-in-time read — Crush computes cost internally.
   */
  private refreshCrushSession(session: TrackedSession): void {
    if (session.remote || session.usage.usageSource === 'native-opencode') return;
    const crushSessions = readCrushSessions();
    const found = crushSessions.find(cs => cs.id === session.sessionId);
    if (!found) return;

    const modelBreakdown: UsageModelBreakdown = found.model ? {
      model: found.model,
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: found.cost,
    } : {
      model: 'unknown',
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: found.cost,
    };

    session.usage = {
      sessionId: found.id,
      cliTool: 'opencode',
      usageSource: 'crush',
      costSource: 'reported',
      collectionStatus: 'available',
      environmentId: session.usage.environmentId,
      inputTokens: found.promptTokens,
      outputTokens: found.completionTokens,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: found.cost,
      models: [modelBreakdown],
      dayTiming: 'snapshot',
      workingDir: found.directory,
      contextUsedTokens: null,
      observedAt: found.updatedAt,
      daily: [{
        date: messageDate(found.updatedAt),
        inputTokens: found.promptTokens,
        outputTokens: found.completionTokens,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCost: found.cost,
        messageCount: found.messageCount,
        models: [modelBreakdown],
      }],
      currentModel: modelBreakdown.model,
      currentReasoningEffort: null,
      contextWindowTokens: null,
      messageCount: found.messageCount,
      firstMessageAt: found.createdAt,
      lastMessageAt: found.updatedAt,
      parsedByteOffset: 0,
    };

    this.persistSession(session);
    this.notifyUpdate();
  }

  private persistSession(session: TrackedSession, markSchemaComplete = true): void {
    const db = getDb();
    const entry: PersistedSessionUsage = {
      sessionId: session.sessionId,
      cliTool: session.cliTool,
      costSource: session.usage.costSource,
      usageSource: session.usage.usageSource,
      workingDir: session.workingDir,
      filePath: session.filePath,
      remote: session.remote,
      lastSeenModel: session.lastSeenModel,
      environmentId: session.usage.environmentId,
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      reasoningTokens: session.usage.reasoningTokens ?? 0,
      cacheCreationTokens: session.usage.cacheCreationTokens,
      cacheReadTokens: session.usage.cacheReadTokens,
      totalCost: session.usage.totalCost,
      models: session.usage.models,
      daily: session.usage.daily,
      dayTiming: session.usage.dayTiming,
      contextUsedTokens: session.usage.contextUsedTokens ?? null,
      observedAt: session.usage.observedAt ?? null,
      currentModel: session.usage.currentModel ?? null,
      currentReasoningEffort: session.usage.currentReasoningEffort ?? null,
      contextWindowTokens: session.usage.contextWindowTokens ?? null,
      codexTokenUsage: session.codexTokenUsage ?? null,
      codexRequestUsage: session.codexRequestUsage ?? null,
      messageCount: session.usage.messageCount,
      firstMessageAt: session.usage.firstMessageAt,
      lastMessageAt: session.usage.lastMessageAt,
      parsedByteOffset: session.usage.parsedByteOffset,
    };
    if (markSchemaComplete) {
      entry.usageSchemaVersion = usageSchemaVersion(session.cliTool);
    }

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
    if (session.remote || session.watching || !session.filePath) return;
    session.watching = true;
    fs.watchFile(session.filePath, { interval: WATCH_POLL_INTERVAL_MS, persistent: false }, (curr, prev) => {
      // File vanished or never existed yet — nothing to parse.
      if (curr.size === 0 && curr.mtimeMs === 0) return;
      // Size or mtime change → schedule a parse. An inode change (atomic
      // replace) means the file is effectively new; reset the offset so we
      // re-parse from the top without keeping old token totals.
      if ((prev.ino !== 0 && curr.ino !== prev.ino) || curr.size < session.usage.parsedByteOffset) {
        this.resetTrackedSessionForReparse(session);
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

  private resetTrackedSessionForReparse(session: TrackedSession): void {
    session.usage = resetUsageForReparse(session.usage);
    session.lastSeenModel = null;
    session.codexTokenUsage = null;
    session.codexRequestUsage = null;
  }

  private reparseSessionPreservingLegacy(session: TrackedSession): boolean {
    const previousUsage = session.usage;
    const previousLastSeenModel = session.lastSeenModel ?? null;
    const previousCodexTokenUsage = session.codexTokenUsage ?? null;
    const previousCodexRequestUsage = session.codexRequestUsage ?? null;
    this.resetTrackedSessionForReparse(session);
    const parsed = this.parseSession(session);
    if (!parsed) {
      session.usage = { ...previousUsage, dayTiming: 'legacy' };
      session.lastSeenModel = previousUsage.dayTiming === 'legacy' ? null : previousLastSeenModel;
      session.codexTokenUsage = previousCodexTokenUsage;
      session.codexRequestUsage = previousCodexRequestUsage;
      this.persistSession(session, false);
      return false;
    }
    return true;
  }

  private buildDailyRollups(): DailyUsage[] {
    const dayMap = new Map<string, DailyUsage>();
    // Side-channel map of per-day → per-tool buckets. Stored separately so the
    // existing DailyUsage day object stays clean during accumulation; merged
    // into each day's `byCliTool` in the finalize pass.
    const dayToolMap = new Map<string, Map<CliToolId, DailyCliToolUsage>>();
    const daySessionMap = new Map<string, Set<string>>();
    const dayToolSessionMap = new Map<string, Map<CliToolId, Set<string>>>();

    const addSessionId = (date: string, cliTool: CliToolId, sessionId: string): void => {
      let sessions = daySessionMap.get(date);
      if (!sessions) {
        sessions = new Set();
        daySessionMap.set(date, sessions);
      }
      sessions.add(sessionId);

      let toolSessions = dayToolSessionMap.get(date);
      if (!toolSessions) {
        toolSessions = new Map();
        dayToolSessionMap.set(date, toolSessions);
      }
      let ids = toolSessions.get(cliTool);
      if (!ids) {
        ids = new Set();
        toolSessions.set(cliTool, ids);
      }
      ids.add(sessionId);
    };

    const addUsage = (
      date: string,
      cliTool: CliToolId,
      sessionId: string,
      usage: Pick<SessionUsage, 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalCost'>,
    ): void => {
      const day = dayMap.get(date) || {
        date,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0,
        sessionCount: 0,
      };

      day.inputTokens += usage.inputTokens;
      day.outputTokens += usage.outputTokens;
      day.reasoningTokens = (day.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
      day.cacheCreationTokens += usage.cacheCreationTokens;
      day.cacheReadTokens += usage.cacheReadTokens;
      day.totalCost += usage.totalCost;
      dayMap.set(date, day);

      let toolMap = dayToolMap.get(date);
      if (!toolMap) {
        toolMap = new Map();
        dayToolMap.set(date, toolMap);
      }
      let toolRow = toolMap.get(cliTool);
      if (!toolRow) {
        toolRow = {
          cliTool,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          sessionCount: 0,
        };
        toolMap.set(cliTool, toolRow);
      }
      toolRow.totalCost += usage.totalCost;
      toolRow.inputTokens += usage.inputTokens;
      toolRow.outputTokens += usage.outputTokens;
      toolRow.reasoningTokens = (toolRow.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
      toolRow.cacheCreationTokens += usage.cacheCreationTokens;
      toolRow.cacheReadTokens += usage.cacheReadTokens;

      addSessionId(date, cliTool, sessionId);
    };

    for (const tracked of this.tracked.values()) {
      const u = tracked.usage;
      if (u.dayTiming === 'legacy') continue;
      if (u.daily && u.daily.length > 0) {
        for (const d of u.daily) {
          addUsage(d.date, u.cliTool, u.sessionId, d);
        }
        continue;
      }
    }

    // Attach per-tool breakdowns, sorted by cost desc, tie-break on cliTool
    // asc to match the aggregator's stable ordering. Drop all-zero tool rows.
    for (const [date, day] of dayMap) {
      const sessionIds = daySessionMap.get(date);
      if (sessionIds) {
        day.sessionIds = Array.from(sessionIds).sort((a, b) => a.localeCompare(b));
        day.sessionCount = day.sessionIds.length;
      }

      const toolMap = dayToolMap.get(date);
      if (!toolMap) continue;
      const rows = Array.from(toolMap.values()).filter(
        r => r.totalCost > 0 || r.inputTokens > 0 || r.outputTokens > 0
          || (r.reasoningTokens ?? 0) > 0 || r.cacheCreationTokens > 0 || r.cacheReadTokens > 0 || r.sessionCount > 0,
      );
      const toolSessionMap = dayToolSessionMap.get(date);
      for (const row of rows) {
        const ids = toolSessionMap?.get(row.cliTool);
        if (!ids) continue;
        row.sessionIds = Array.from(ids).sort((a, b) => a.localeCompare(b));
        row.sessionCount = row.sessionIds.length;
      }
      rows.sort((a, b) => {
        if (a.totalCost !== b.totalCost) return b.totalCost - a.totalCost;
        return a.cliTool.localeCompare(b.cliTool);
      });
      if (rows.length > 0) day.byCliTool = rows;
    }

    return Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  private notifyUpdate(): void {
    this.callback?.(this.getAll());
  }

  stop(): void {
    this.stopped = true;
    this.nativeGeneration++;
    if (this.backfillTask) clearImmediate(this.backfillTask);
    this.backfillTask = null;
    if (this.nativePoll) clearInterval(this.nativePoll);
    this.nativePoll = null;
    this.nativeContexts.clear();
    this.nativeRefresh = null;
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
