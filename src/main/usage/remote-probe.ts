/**
 * Executed by a remote Node.js process over a separate command channel. No
 * helper installation, CLI config edits, or transcript text written locally.
 * Keep this self-contained: the remote host has only Node's standard library.
 */
export const REMOTE_USAGE_PROBE = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const maxChunk = 1024 * 1024;
const maxLine = 16 * maxChunk;
const userHome = request.home || os.homedir();
const homePath = (value, fallback, base = process.cwd()) => {
  const p = value || fallback;
  return path.resolve(base, p === '~' ? userHome : p.startsWith('~/') ? path.join(userHome, p.slice(2)) : p);
};
const cwd = homePath(request.workingDir, userHome);
const home = homePath(request.cli === 'claude' ? request.claudeHome || process.env.CLAUDE_CONFIG_DIR : request.codexHome || process.env.CODEX_HOME,
  path.join(userHome, request.cli === 'claude' ? '.claude' : '.codex'), cwd);
const root = path.join(home, request.cli === 'claude' ? 'projects' : 'sessions');
const scope = JSON.stringify([typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username, home]);
function firstLine(file) {
  const fd = typeof file === 'number' ? file : fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let length = Math.min(65536, size);
    while (true) {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const end = buf.subarray(0, n).indexOf(10);
      if (end >= 0) return buf.subarray(0, end).toString('utf8');
      if (n < length || length >= size) return '';
      if (length >= maxLine) throw new Error('header-too-large');
      length = Math.min(length * 2, maxLine, size);
    }
  } finally { if (typeof file !== 'number') fs.closeSync(fd); }
}
function codexMeta(file) {
  try {
    const entry = JSON.parse(firstLine(file));
    return entry.type === 'session_meta' && typeof entry.payload?.id === 'string' ? entry.payload : null;
  } catch { return null; }
}
function inside(file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel) && file.endsWith('.jsonl');
}
function resolveSource() {
  let file;
  let nativeId = request.nativeSessionId;
  if (request.cli === 'claude' && nativeId && /^[a-zA-Z0-9-]+$/.test(nativeId)) {
    let realCwd = cwd;
    try { realCwd = fs.realpathSync(cwd); } catch {}
    file = path.join(root, realCwd.replace(/[\\/:]/g, '-'), nativeId + '.jsonl');
  } else if (request.cli === 'codex') {
    if (process.platform !== 'linux') throw new Error('unsupported-platform');
    // The CLI and its children inherit a non-secret Tether marker. On Linux,
    // match their actual open rollout files instead of guessing by cwd/time.
    // Multiple sessions in the same directory therefore cannot steal usage.
    const candidates = new Map();
    if (process.platform === 'linux') {
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
          if (!env.includes('TETHER_USAGE_SESSION_ID=' + request.marker)) continue;
          for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) {
            try {
              const candidate = fs.readlinkSync('/proc/' + pid + '/fd/' + fd);
              if (!inside(candidate)) continue;
              const meta = codexMeta(candidate);
              if (meta && (meta.source === 'cli' || meta.source === undefined) && (!nativeId || nativeId === meta.id)) candidates.set(candidate, meta.id);
            } catch {}
          }
        } catch {}
      }
    }
    if (candidates.size === 1) [file, nativeId] = candidates.entries().next().value;
  }
  if (!file || !nativeId) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { scope, path: file, nativeSessionId: nativeId, identity: '' };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function numberFields(obj, fields) {
  const out = {};
  for (const name of fields) {
    const value = obj?.[name];
    if (Number.isSafeInteger(value) && value >= 0) out[name] = value;
  }
  return out;
}
function codexCounters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  // Reject malformed counters rather than turning them into measured zeros.
  if (fields.some(name => value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 0))) return null;
  return numberFields(value, fields);
}
function sanitize(entry) {
  const timestamp = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
    ? new Date(entry.timestamp).toISOString() : undefined;
  const model = value => typeof value === 'string' && value.length <= 200 ? value : undefined;
  if (request.cli === 'claude' && entry.type === 'assistant' && entry.message?.usage) {
    const u = entry.message.usage;
    const usage = numberFields(u, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
    if (u.cache_creation) usage.cache_creation = numberFields(u.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
    return { type: 'assistant', timestamp, message: { model: model(entry.message.model), usage } };
  }
  if (request.cli === 'codex' && entry.type === 'turn_context') {
    const effort = entry.payload?.effort ?? entry.payload?.collaboration_mode?.settings?.reasoning_effort;
    return { type: 'turn_context', timestamp, payload: {
      model: model(entry.payload?.model), effort: model(effort),
      ...numberFields(entry.payload, ['model_context_window'])
    } };
  }
  if (request.cli === 'codex' && entry.type === 'event_msg' && entry.payload?.type === 'task_started') {
    return { type: 'event_msg', timestamp, payload: { type: 'task_started', ...numberFields(entry.payload, ['model_context_window']) } };
  }
  if (request.cli === 'codex' && entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.info) {
    return { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      last_token_usage: codexCounters(entry.payload.info.last_token_usage),
      total_token_usage: codexCounters(entry.payload.info.total_token_usage),
      ...numberFields(entry.payload.info, ['model_context_window'])
    } } };
  }
  return null;
}
function read(source) {
  if (source.scope !== scope || !inside(source.path)) throw new Error('source-changed');
  const fd = fs.openSync(source.path, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not-file');
    const header = firstLine(fd);
    if (request.cli === 'codex' && header && JSON.parse(header).payload?.id !== source.nativeSessionId) throw new Error('source-changed');
    const identity = [stat.dev, stat.ino, crypto.createHash('sha256').update(header).digest('hex')].join(':');
    const reset = request.cursor.identity !== identity || stat.size < request.cursor.offset;
    const start = reset ? 0 : request.cursor.offset;
    let size = Math.min(maxChunk, stat.size - start);
    let buf;
    let end;
    while (true) {
      buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, start);
      buf = buf.subarray(0, n);
      end = buf.lastIndexOf(10) + 1;
      if (end || n < size || start + size >= stat.size) break;
      if (size >= maxLine) throw new Error('line-too-large');
      size = Math.min(size * 2, maxLine, stat.size - start);
    }
    const records = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object') continue;
        const safe = sanitize(entry);
        if (safe) records.push(JSON.stringify(safe));
      } catch {}
    }
    return { status: 'ready', source: { ...source, identity }, reset, offset: start + end,
      more: end > 0 && start + end < stat.size, text: records.length ? records.join('\n') + '\n' : '' };
  } finally { fs.closeSync(fd); }
}
try {
  const source = request.source || resolveSource();
  const reply = !source ? { status: 'pending' } : request.cursor ? read(source) : { status: 'ready', source };
  process.stdout.write('__TETHER_USAGE__' + JSON.stringify(reply) + '\n');
} catch {
  // Never forward filesystem errors, paths, environment values, or transcript text.
  process.stdout.write('__TETHER_USAGE__' + JSON.stringify({ error: 'remote-read-failed' }) + '\n');
  process.exitCode = 1;
}
`;
