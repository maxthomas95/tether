import { connectRemoteUsage, type RemoteUsageConnection } from './remote-command';
import { remoteUsageKey, type RemoteUsageCli, type RemoteUsageRequest, type RemoteUsageSource } from './remote-protocol';
import { usageService } from './usage-service';
import { createLogger } from '../logger';

const log = createLogger('remote-usage');
const POLL_MS = 10_000;
const RETRY_MS = 30_000;

export interface RemoteUsageSession {
  sessionId: string;
  environmentId: string;
  workspace: string;
  workingDir: string;
  home?: string;
  cli: RemoteUsageCli;
  nativeSessionId?: string;
  claudeHome?: string;
  codexHome?: string;
  onSource: (key: string, nativeSessionId: string) => void;
  onStatus: (status: 'pending' | 'collecting' | 'unavailable') => void;
}

interface Entry {
  options: RemoteUsageSession;
  source?: RemoteUsageSource;
  key?: string;
  finishing: boolean;
}

interface Group {
  environmentId: string;
  workspace: string;
  entries: Map<string, Entry>;
  connection?: RemoteUsageConnection;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  closed: boolean;
  abort: AbortController;
}

export class RemoteUsageService {
  private groups = new Map<string, Group>();

  constructor(
    private readonly connect = connectRemoteUsage,
    private readonly usage = usageService,
  ) {}

  start(options: RemoteUsageSession): void {
    const key = JSON.stringify([options.environmentId, options.workspace]);
    let group = this.groups.get(key);
    if (!group) {
      group = { environmentId: options.environmentId, workspace: options.workspace,
        entries: new Map(), running: false, closed: false, abort: new AbortController() };
      this.groups.set(key, group);
    }
    group.entries.set(options.sessionId, { options, finishing: false });
    options.onStatus('pending');
    if (group.timer) clearTimeout(group.timer);
    if (!group.running) void this.poll(group);
  }

  stop(sessionId: string): void {
    for (const group of this.groups.values()) {
      const entry = group.entries.get(sessionId);
      if (!entry) continue;
      entry.finishing = true;
      if (group.timer) clearTimeout(group.timer);
      if (!group.running) void this.poll(group);
    }
  }

  private async read(group: Group, entry: Entry): Promise<boolean> {
    const o = entry.options;
    const request: RemoteUsageRequest = { cli: o.cli, marker: o.sessionId, nativeSessionId: o.nativeSessionId,
      workingDir: o.workingDir, home: o.home, claudeHome: o.claudeHome, codexHome: o.codexHome, source: entry.source };
    if (!entry.source) {
      const reply = await group.connection!.poll(request);
      if (group.closed || reply.status === 'pending' || !reply.source) return false;
      entry.source = reply.source;
      entry.key = remoteUsageKey(o.environmentId, o.workspace, o.cli, reply.source);
      o.onSource(entry.key, reply.source.nativeSessionId);
    }
    const cursor = this.usage.trackRemote(entry.key!, o.workingDir, o.cli, o.environmentId, entry.source);
    const reply = await group.connection!.poll({ ...request, source: entry.source, cursor });
    if (group.closed) return false;
    if (reply.status !== 'ready' || reply.offset === undefined) throw new Error('Remote usage read incomplete');
    this.usage.applyRemote(entry.key!, reply);
    entry.source = reply.source;
    o.onStatus('collecting');
    return reply.more === true;
  }

  private async poll(group: Group): Promise<void> {
    if (group.closed || group.running) return;
    group.running = true;
    let delay = POLL_MS;
    let failed = false;
    try {
      if (!group.connection) {
        const connection = await this.connect(group.environmentId, group.workspace, group.abort.signal);
        if (group.closed) { connection.close(); return; }
        group.connection = connection;
      }
      for (const [id, entry] of group.entries) {
        if (group.closed) break;
        const finalRead = entry.finishing;
        // One bounded chunk per session per pass keeps backfill fair.
        try {
          const more = await this.read(group, entry);
          if (more) delay = 250;
          if (finalRead && !more) group.entries.delete(id);
          else if (entry.finishing) delay = 250;
          else if (!entry.source) delay = Math.min(delay, 2000);
        } catch {
          if (group.closed) break;
          failed = true;
          entry.options.onStatus('unavailable');
          if (entry.finishing) group.entries.delete(id);
        }
      }
      if (failed) {
        group.connection?.close();
        group.connection = undefined;
        delay = RETRY_MS;
      }
    } catch {
      if (group.closed) return;
      // Do not log remote stderr/commands or resolved credential values.
      log.debug('Remote usage will retry', { environmentId: group.environmentId });
      for (const [id, entry] of group.entries) {
        entry.options.onStatus('unavailable');
        if (entry.finishing) group.entries.delete(id);
      }
      group.connection?.close();
      group.connection = undefined;
      delay = RETRY_MS;
    } finally {
      group.running = false;
      if (!group.closed && group.entries.size) {
        group.timer = setTimeout(() => void this.poll(group), delay);
      } else this.closeGroup(group);
    }
  }

  private closeGroup(group: Group): void {
    if (group.closed) return;
    group.closed = true;
    group.abort.abort();
    if (group.timer) clearTimeout(group.timer);
    group.connection?.close();
    this.groups.delete(JSON.stringify([group.environmentId, group.workspace]));
  }

  dispose(): void {
    for (const group of this.groups.values()) this.closeGroup(group);
  }
}

export const remoteUsageService = new RemoteUsageService();
