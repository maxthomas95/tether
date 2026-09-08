export type RemoteUsageCli = 'claude' | 'codex';

export interface RemoteUsageSource {
  /** Distinguishes local data and identical native ids on different hosts/users. */
  scope: string;
  nativeSessionId: string;
  path: string;
  identity: string;
}

export interface RemoteUsageCursor {
  offset: number;
  identity: string;
}

export interface RemoteUsageRequest {
  cli: RemoteUsageCli;
  marker: string;
  nativeSessionId?: string;
  workingDir: string;
  home?: string;
  claudeHome?: string;
  codexHome?: string;
  source?: RemoteUsageSource;
  cursor?: RemoteUsageCursor;
}

export interface RemoteUsageReply {
  status: 'ready' | 'pending';
  source?: RemoteUsageSource;
  /** Sanitized JSONL: only model, timestamp, and numeric usage fields. */
  text?: string;
  offset?: number;
  reset?: boolean;
  more?: boolean;
}

export function remoteUsageKey(environmentId: string, workspace: string, cli: RemoteUsageCli, source: RemoteUsageSource): string {
  // JSON encoding is unambiguous even when names contain delimiters.
  return `remote:${JSON.stringify([environmentId, workspace, cli, source.scope, source.nativeSessionId])}`;
}
