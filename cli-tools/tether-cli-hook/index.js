#!/usr/bin/env node
// tether-cli-hook — tiny stdlib-only helper that forwards CLI hook
// payloads to the Tether main process via the hook bridge socket.
//
// Invocation:
//   node index.js --claude        # reads Claude hook payload from stdin
//   node index.js --codex <json>  # Codex passes payload as argv[1]
//
// Environment (set by Tether at CLI spawn time, inherited through the CLI
// process to this helper):
//   TETHER_HOOK_SOCKET  named-pipe path (Windows) or UDS path (POSIX)
//   TETHER_HOOK_TOKEN   per-Tether-boot auth token
//   TETHER_SESSION_ID   the Tether session id this CLI belongs to
//
// Exit codes:
//   0  payload accepted (or bridge unavailable — non-fatal for the CLI)
//   2  Stop hook only — block continuation. We never block, so we never
//      return 2; documented here so a future change is explicit.
//
// Non-blocking errors only — anything on stderr surfaces in the user's
// terminal via Claude's hook contract. Stay silent unless something is
// truly wrong, and even then keep it terse.

'use strict';

const net = require('node:net');
const fs = require('node:fs');

const SOCKET = process.env.TETHER_HOOK_SOCKET;
const TOKEN = process.env.TETHER_HOOK_TOKEN;
const SESSION_ID = process.env.TETHER_SESSION_ID;
const DEBUG_LOG = process.env.TETHER_HOOK_LOG_PATH;

// Best-effort one-line trace per invocation, controlled by an env var Tether
// sets in dev mode. Helps debug "the hook never fires" / "the helper
// silently degrades" cases without polluting Claude's terminal stderr.
function dbg(msg, extra) {
  if (!DEBUG_LOG) return;
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      pid: process.pid,
      sid: SESSION_ID || null,
      mode: process.argv[2] || null,
      msg,
      ...(extra || {}),
    }) + '\n';
    fs.appendFileSync(DEBUG_LOG, line);
  } catch { /* never fail the hook because logging failed */ }
}

dbg('invoked', { hasSocket: !!SOCKET, hasToken: !!TOKEN, hasSessionId: !!SESSION_ID });

// Bridge unreachable or env not wired → silently exit 0. The byte-level
// detector remains as a fallback, so a missing hook signal degrades to
// the previous behavior rather than breaking the user's session.
if (!SOCKET || !TOKEN || !SESSION_ID) {
  dbg('exit-no-env');
  process.exit(0);
}

const mode = process.argv[2];
if (mode !== '--claude' && mode !== '--codex') {
  dbg('exit-bad-mode');
  process.exit(0);
}

const source = mode === '--claude' ? 'claude' : 'codex';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function classifyClaude(payload) {
  // Claude hook payloads carry `hook_event_name` ('Notification' | 'Stop' | ...)
  // and, for Notification, `notification_type` ('permission_prompt' |
  // 'idle_prompt' | 'auth_success' | ...). Map both into our flat event
  // enum so the detector doesn't need to know the Claude schema.
  if (payload.hook_event_name === 'Stop') return 'turn_complete';
  if (payload.hook_event_name === 'Notification') {
    const t = payload.notification_type;
    if (t === 'permission_prompt') return 'permission_prompt';
    if (t === 'idle_prompt') return 'idle_prompt';
    if (t === 'auth_success') return 'auth_success';
    if (t === 'elicitation_dialog') return 'elicitation_dialog';
  }
  return null;
}

function classifyCodex(payload) {
  // Codex emits a single event type today (`agent-turn-complete`). When
  // upstream adds richer events (codex#4005 etc.), extend here.
  if (payload.type === 'agent-turn-complete') return 'turn_complete';
  return null;
}

async function main() {
  let payloadText = '';
  if (mode === '--claude') {
    payloadText = await readStdin();
  } else {
    payloadText = process.argv[3] || '';
  }

  let payload;
  try { payload = JSON.parse(payloadText); }
  catch { dbg('exit-bad-json', { rawLen: payloadText.length }); process.exit(0); }
  if (!payload || typeof payload !== 'object') { dbg('exit-payload-not-object'); process.exit(0); }

  const type = source === 'claude' ? classifyClaude(payload) : classifyCodex(payload);
  if (!type) {
    dbg('exit-unclassified', {
      hookEventName: payload.hook_event_name,
      notificationType: payload.notification_type,
      codexType: payload.type,
    });
    process.exit(0);
  }
  dbg('classified', { type });

  // Connect, auth, send, exit. Hard 1s timeout on the whole round-trip —
  // if the bridge is down, we don't want to hang Claude's hook pipeline.
  const sock = net.connect(SOCKET);
  const timer = setTimeout(() => {
    dbg('exit-timeout');
    sock.destroy();
    process.exit(0);
  }, 1000);

  let buffer = '';
  let authed = false;

  sock.on('connect', () => {
    dbg('connected');
    sock.write(JSON.stringify({ id: 'auth', method: 'authenticate', token: TOKEN }) + '\n');
  });
  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!authed) {
        if (frame && frame.result && frame.result.ok) {
          authed = true;
          dbg('authed');
          sock.write(JSON.stringify({
            id: 'evt',
            method: 'event',
            tetherSessionId: SESSION_ID,
            type,
            source,
            payload,
          }) + '\n');
        } else {
          dbg('exit-auth-failed', { frame });
          sock.destroy();
          clearTimeout(timer);
          process.exit(0);
        }
      } else {
        dbg('exit-event-acked', { result: frame && frame.result });
        sock.destroy();
        clearTimeout(timer);
        process.exit(0);
      }
    }
  });
  sock.on('error', (err) => {
    dbg('exit-socket-error', { err: err && err.message });
    clearTimeout(timer);
    process.exit(0);
  });
  sock.on('close', () => { clearTimeout(timer); process.exit(0); });
}

main();
