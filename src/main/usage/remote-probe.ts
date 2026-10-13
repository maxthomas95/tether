/**
 * Executed by a remote Node.js process over a separate command channel. No
 * helper installation, CLI config edits, or transcript text written locally.
 * Keep this self-contained: the remote host has only Node's standard library.
 *
 * Two drive modes, same reader. With a base64 request in argv the probe answers
 * once and exits. With no argv request it stays resident and answers one
 * newline-delimited base64 request per line, so a `useSudo` host authenticates
 * once per connection instead of once per poll.
 */
export const REMOTE_USAGE_PROBE = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const maxChunk = 1024 * 1024;
const maxLine = 16 * maxChunk;
// Derived per request so one resident probe can serve several sessions.
let request, userHome, cwd, home, root, scope;
const homePath = (value, fallback, base = process.cwd()) => {
  const p = value || fallback;
  return path.resolve(base, p === '~' ? userHome : p.startsWith('~/') ? path.join(userHome, p.slice(2)) : p);
};
function setRequest(next) {
  request = next;
  userHome = request.home || os.homedir();
  cwd = homePath(request.workingDir, userHome);
  home = homePath(request.cli === 'claude' ? request.claudeHome || process.env.CLAUDE_CONFIG_DIR : request.codexHome || process.env.CODEX_HOME,
    path.join(userHome, request.cli === 'claude' ? '.claude' : '.codex'), cwd);
  root = path.join(home, request.cli === 'claude' ? 'projects' : 'sessions');
  scope = JSON.stringify([typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username, home]);
}
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
// Claude appends a hash we cannot recompute to project names over 200
// characters, so fall back to the one transcript carrying this session id.
function findClaudeTranscript(name) {
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  const found = dirs.map(dir => path.join(root, dir, name)).filter(f => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
  return found.length === 1 ? found[0] : null;
}
function resolveSource() {
  let file;
  let nativeId = request.nativeSessionId;
  if (request.cli === 'claude' && nativeId && /^[a-zA-Z0-9-]+$/.test(nativeId)) {
    let realCwd = cwd;
    try { realCwd = fs.realpathSync(cwd); } catch {}
    file = path.join(root, realCwd.replace(/[^a-zA-Z0-9]/g, '-'), nativeId + '.jsonl');
    if (!fs.existsSync(file)) file = findClaudeTranscript(nativeId + '.jsonl') || file;
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
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  // Reject malformed counters rather than turning them into measured zeros.
  if (fields.some(name => value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 0))) return null;
  return numberFields(value, fields);
}
function sanitize(entry, nativeSessionId) {
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
  if (request.cli === 'codex' && entry.type === 'token_usage_record') {
    // Parent request records copied into a fork's history are not its spend.
    if (entry.payload?.thread_id !== nativeSessionId) return null;
    return { type: 'token_usage_record', timestamp, payload: {
      thread_id: nativeSessionId,
      usage: codexCounters(entry.payload.usage),
      thread_token_usage: codexCounters(entry.payload.thread_token_usage)
    } };
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
        const safe = sanitize(entry, source.nativeSessionId);
        if (safe) records.push(JSON.stringify(safe));
      } catch {}
    }
    return { status: 'ready', source: { ...source, identity }, reset, offset: start + end,
      more: end > 0 && start + end < stat.size, text: records.length ? records.join('\n') + '\n' : '' };
  } finally { fs.closeSync(fd); }
}
// Subagent requests. Same process, same read-only stance: this lists one
// session's subagents folder and returns bytes after a caller-held offset.
// The listing sends slimmed lines (only what the summary needs: see slimLine);
// full lines leave only for the transcript viewer. All bounds live here so a
// runaway folder cannot make a response unbounded.
const SUB_AGENTS = 50;
const SUB_SCAN = 1000;
// Raw bytes read per file window, per response, and the longest line carried.
const SUB_WINDOW = 2 * 1024 * 1024;
const SUB_READ = 8 * 1024 * 1024;
const SUB_LINE = 4 * 1024 * 1024;
// Slimmed text returned per response (listing), and raw text per viewer chunk.
const SUB_OUT = 1024 * 1024;
const SUB_VIEW = 1024 * 1024;
const SUB_META = 16 * 1024;
const SUB_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
const SUB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUB_SPAWN = new Set(['Agent', 'Task']);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (v, n) => typeof v === 'string' && v.length ? v.slice(0, n) : undefined;
// Claude hash-suffixes long project folder names, so a folder derived from the
// working directory is only a first guess; otherwise take the one project
// folder that holds this session id.
function subagentsDir() {
  const sid = request.sessionId;
  if (typeof sid !== 'string' || !SUB_SESSION.test(sid)) throw new Error('bad-session');
  const at = project => path.join(root, project, sid, 'subagents');
  const hint = typeof request.project === 'string' && request.project && path.basename(request.project) === request.project ? request.project : null;
  if (hint && isDir(at(hint))) return { dir: at(hint), project: hint };
  let realCwd = cwd;
  try { realCwd = fs.realpathSync(cwd); } catch {}
  const direct = realCwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (isDir(at(direct))) return { dir: at(direct), project: direct };
  if (request.scan === false) return null;
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  const found = names.filter(name => isDir(at(name)));
  return found.length === 1 ? { dir: at(found[0]), project: found[0] } : null;
}
// Complete lines from offset, at most about "want" bytes. A line with no newline
// inside the window is read once more at the larger line limit; beyond that it
// is skipped (the caller sees the offset move past it and parses the stub as
// the garbage it is). A partial line at the end of the file waits for its newline;
// "eof" says the window reached the end of the file, so nothing more is readable yet.
function readLines(fd, size, offset, want) {
  const slice = n => {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, offset);
    return buf.subarray(0, got);
  };
  let buf = slice(Math.min(want, size - offset));
  let end = buf.lastIndexOf(10) + 1;
  if (!end && offset + buf.length < size) {
    buf = slice(Math.min(SUB_LINE, size - offset));
    end = buf.lastIndexOf(10) + 1;
    if (!end && offset + buf.length < size) return { buf: Buffer.alloc(0), next: offset + buf.length, eof: false };
  }
  return { buf: buf.subarray(0, end), next: offset + end, eof: offset + buf.length >= size };
}
// The listing's summary reads, per line: type, timestamp; for a user line whether
// it carries a tool result, and, on the first plain user line of the file only,
// its prompt text (first 400 chars); for an assistant
// line model, effort, request/response ids, usage counters and the ids of Agent
// and Task calls (to place nested subagents). Nothing else is forwarded: no
// message content, tool inputs or tool results. This must track what
// foldSubagentLines in claude/subagents.ts reads; its test compares both.
// "prompt" is false once the caller already holds the task prompt, and flips to
// true here when a line carries it, so only the first plain user line sends text.
function slimLine(line, prompt) {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  let e;
  try { e = JSON.parse(text); } catch { return null; }
  if (!isObj(e) || e.type === 'fork-context-ref') return null;
  const out = {};
  if (typeof e.type === 'string' && e.type.length <= 40) out.type = e.type;
  if (typeof e.timestamp === 'string' && e.timestamp.length <= 64) out.timestamp = e.timestamp;
  const m = isObj(e.message) ? e.message : null;
  if (out.type === 'user' && m) {
    if (typeof m.content === 'string') {
      const body = prompt.taken ? '' : m.content.trimStart().slice(0, 400);
      if (body.trim()) prompt.taken = true;
      out.message = { content: body };
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      let chars = 0;
      let results = false;
      for (const b of m.content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_result') results = true;
        else if (b.type === 'text' && typeof b.text === 'string' && chars < 400 && !prompt.taken) { blocks.push({ type: 'text', text: b.text.slice(0, 400) }); chars += b.text.length; }
      }
      // A user line with a tool result is never the prompt, whatever text it also holds.
      if (!results && blocks.some(b => b.text.trim())) prompt.taken = true;
      out.message = { content: (results ? [{ type: 'tool_result' }] : []).concat(results ? [] : blocks) };
    }
  } else if (out.type === 'assistant' && m) {
    const message = {};
    const model = clip(m.model, 100);
    const id = clip(m.id, 128);
    if (model) message.model = model;
    if (id) message.id = id;
    if (isObj(m.usage)) {
      message.usage = {};
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (typeof m.usage[k] === 'number' && Number.isFinite(m.usage[k])) message.usage[k] = m.usage[k];
      }
    }
    if (Array.isArray(m.content)) {
      message.content = m.content.filter(b => isObj(b) && b.type === 'tool_use' && SUB_SPAWN.has(b.name) && typeof b.id === 'string' && b.id.length <= 256)
        .map(b => ({ type: 'tool_use', name: b.name, id: b.id }));
    }
    out.message = message;
    const effort = clip(e.effort, 40);
    if (effort) out.effort = effort;
    for (const k of ['requestId', 'uuid']) { const v = clip(e[k], 128); if (v) out[k] = v; }
  }
  return JSON.stringify(out);
}
// Slim whole lines from buf until about "cap" characters are produced; the rest
// is left for the next request. "consumed" is the raw bytes handled.
function slimLines(buf, cap, prompt) {
  let out = '';
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const taken = prompt.taken;
    const slim = slimLine(buf.toString('utf8', pos, nl), prompt);
    // A line left for the next request must not have used up the prompt.
    if (slim && out && out.length + slim.length + 1 > cap) { prompt.taken = taken; break; }
    if (slim) out += slim + '\n';
    pos = nl + 1;
  }
  return { text: out, consumed: pos };
}
function metaOf(dir, id, heldMtime) {
  let mtimeMs = 0;
  let text;
  try {
    const file = path.join(dir, 'agent-' + id + '.meta.json');
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    if (mtimeMs !== heldMtime) text = st.size <= SUB_META ? fs.readFileSync(file, 'utf8') : '';
  } catch { if (heldMtime !== 0) text = ''; }
  return { metaMtimeMs: mtimeMs, ...(text === undefined ? {} : { meta: text }) };
}
function listSubagents() {
  const base = { op: 'subagents', status: 'ready', total: 0, more: false, agents: [], now: Date.now() };
  const located = subagentsDir();
  let names;
  try { names = located ? fs.readdirSync(located.dir) : []; } catch { names = []; }
  if (!located || !names.length) return { ...base, found: !!located, project: located ? located.project : undefined };
  const present = [];
  let seen = 0;
  for (const name of names) {
    const match = SUB_FILE.exec(name);
    if (!match) continue;
    if (++seen > SUB_SCAN) break;
    try {
      const st = fs.statSync(path.join(located.dir, name));
      if (st.isFile()) present.push({ id: match[1], size: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs });
    } catch {}
  }
  present.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  const held = new Map(Object.entries(request.known && typeof request.known === 'object' ? request.known : {}));
  let rawBudget = SUB_READ;
  let outBudget = SUB_OUT;
  let more = false;
  const agents = [];
  for (const f of present.slice(0, SUB_AGENTS)) {
    const mine = held.get(f.id) || {};
    let offset = count(mine.offset);
    const reset = offset > f.size;
    if (reset) offset = 0;
    let text = '';
    if (offset < f.size && rawBudget >= 4096 && outBudget >= 8192) {
      let fd;
      try {
        fd = fs.openSync(path.join(located.dir, 'agent-' + f.id + '.jsonl'), 'r');
        const read = readLines(fd, f.size, offset, Math.min(SUB_WINDOW, rawBudget));
        const slim = read.buf.length ? slimLines(read.buf, outBudget, { taken: !reset && mine.prompt === true }) : { text: '', consumed: 0 };
        const next = read.buf.length ? offset + slim.consumed : read.next;
        text = slim.text;
        rawBudget -= next - offset;
        outBudget -= text.length;
        // A file whose only unread bytes are a partial last line is not "more".
        if (next !== offset && (slim.consumed < read.buf.length || !read.eof)) more = true;
        offset = next;
      } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    } else if (offset < f.size) more = true;
    agents.push({ ...f, offset, ...(reset ? { reset: true } : {}), text, ...metaOf(located.dir, f.id, mine.metaMtimeMs === undefined ? -1 : mine.metaMtimeMs) });
  }
  return { ...base, found: true, project: located.project, agents, total: present.length, more };
}
function readTranscript() {
  const base = { op: 'subagent-transcript', status: 'ready', text: '', offset: 0, size: 0, more: false };
  if (typeof request.agentId !== 'string' || !SUB_ID.test(request.agentId)) throw new Error('bad-agent');
  const located = subagentsDir();
  if (!located) return { ...base, found: false };
  const fd = (() => { try { return fs.openSync(path.join(located.dir, 'agent-' + request.agentId + '.jsonl'), 'r'); } catch { return undefined; } })();
  if (fd === undefined) return { ...base, found: false, project: located.project };
  try {
    const size = fs.fstatSync(fd).size;
    let offset = count(request.offset);
    const reset = offset > size;
    if (reset) offset = 0;
    const read = readLines(fd, size, offset, SUB_VIEW);
    return { ...base, found: true, project: located.project, text: read.buf.toString('utf8'), offset: read.next, size,
      ...(reset ? { reset: true } : {}), more: !read.eof && read.next > offset };
  } finally { fs.closeSync(fd); }
}
function handleSubagents(next) {
  if (next.cli !== 'claude') throw new Error('bad-cli');
  setRequest(next);
  return next.op === 'subagents' ? listSubagents() : readTranscript();
}
function handle(next) {
  try {
    if (next.op === 'subagents' || next.op === 'subagent-transcript') return handleSubagents(next);
    setRequest(next);
    const source = request.source || resolveSource();
    return !source ? { status: 'pending' } : request.cursor ? read(source) : { status: 'ready', source };
  } catch {
    // Never forward filesystem errors, paths, environment values, or transcript text.
    return { error: 'remote-read-failed' };
  }
}
function emit(reply, id) {
  process.stdout.write('__TETHER_USAGE__' + JSON.stringify(id === undefined ? reply : { ...reply, id }) + '\n');
}
if (process.argv[1]) {
  const reply = handle(JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8')));
  emit(reply);
  if (reply.error) process.exitCode = 1;
} else {
  // Resident mode. A bad line answers and keeps serving; only stdin closing ends us.
  // The caller's token proves we started (so sudo accepted the password) before it
  // sends any request; without one there is nothing to prove.
  const readyToken = process.env.TETHER_PROBE_READY;
  if (readyToken) process.stdout.write('__TETHER_USAGE__' + JSON.stringify({ ready: readyToken }) + '\n');
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += chunk;
    let cut;
    while ((cut = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      if (!line) continue;
      let id;
      try {
        const next = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
        id = next.id;
        emit(handle(next), id);
      } catch { emit({ error: 'remote-read-failed' }, id); }
    }
    if (buffered.length > maxChunk) { buffered = ''; emit({ error: 'remote-read-failed' }); }
  });
  process.stdin.on('end', () => process.exit(0));
}
`;
