import os from 'node:os';
import path from 'node:path';
import { runCliMetadata } from '../cli/metadata-command';

export interface OpenCodeUsageContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// Only source-location and executable-resolution overrides are needed. Keep
// session API credentials out of this cache and out of path discovery.
const SOURCE_KEYS = new Set([
  'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB', 'XDG_DATA_HOME', 'HOME',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'OPENCODE_BIN_PATH',
]);

export function openCodeUsageContext(cwd: string, env: NodeJS.ProcessEnv = {}): OpenCodeUsageContext {
  return {
    cwd,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => SOURCE_KEYS.has(key.toUpperCase()))),
  };
}

export class NativeOpenCodeUsageSource {
  private cache = new Map<string, { path: string | null; expires: number }>();
  private pending = new Map<string, Promise<string | null>>();

  async resolvePath(context: OpenCodeUsageContext = {}): Promise<string | null> {
    const cwd = context.cwd ?? os.homedir();
    const filtered = openCodeUsageContext(cwd, context.env);
    const key = JSON.stringify([cwd, Object.entries(filtered.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.path;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.discover(filtered).then(dbPath => {
      this.cache.set(key, { path: dbPath, expires: Date.now() + (dbPath ? 300_000 : 30_000) });
      return dbPath;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async discover(context: OpenCodeUsageContext): Promise<string | null> {
    const env = new Map(Object.entries(process.env).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));
    for (const [key, value] of Object.entries(context.env ?? {})) env.set(process.platform === 'win32' ? key.toUpperCase() : key, value);
    const home = process.platform === 'win32'
      ? env.get('USERPROFILE') || os.homedir()
      : env.get('HOME') || os.homedir();
    const data = path.resolve(context.cwd ?? os.homedir(), env.get('XDG_DATA_HOME') || path.join(home, '.local', 'share'), 'opencode');
    const override = env.get('OPENCODE_DB');
    if (override === ':memory:' || override?.includes('\0')) return null;
    if (override) return path.isAbsolute(override)
      ? path.resolve(context.cwd ?? os.homedir(), override) : path.join(data, override);
    if (['true', '1'].includes((env.get('OPENCODE_DISABLE_CHANNEL_DB') ?? '').toLowerCase())) return path.join(data, 'opencode.db');

    // `db path` runs command middleware that may create/migrate the database.
    // Yargs handles --version before that middleware. Mirror the pinned native
    // layout for official release builds; custom builds need OPENCODE_DB.
    const result = await runCliMetadata('opencode', ['--version'], {
      timeoutMs: 5_000, maxBytes: 4096, cwd: context.cwd, env: context.env,
    });
    if (!result.ok) return null;
    const version = result.stdout.trim();
    if (/^\d+\.\d+\.\d+$/.test(version)) return path.join(data, 'opencode.db');
    const preview = /^0\.0\.0-([a-zA-Z0-9._-]+)-\d{12,14}$/.exec(version);
    if (!preview) return null;
    const channel = preview[1];
    return path.join(data, ['latest', 'beta', 'prod'].includes(channel) ? 'opencode.db' : `opencode-${channel}.db`);
  }
}
