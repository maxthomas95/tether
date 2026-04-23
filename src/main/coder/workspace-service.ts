import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getEnvironment } from '../db/environment-repo';
import { createLogger } from '../logger';
import type { CoderWorkspace, CoderTemplate, CoderTemplateParam, CreateCoderWorkspaceOptions } from '../../shared/types';

const log = createLogger('coder-workspace');

/**
 * Strip terminal escape sequences from captured PTY output so the text is
 * loggable and regex-matchable. Covers CSI (`ESC [ ... letter`), OSC
 * (`ESC ] ... BEL|ESC \`), and two-byte charset-select escapes. The narrower
 * CSI-only regex the service used previously left OSC payloads and hyperlink
 * terminators embedded in the "cleaned" output, which is how useful error
 * content like the missing-file path ended up getting discarded.
 */
function stripAnsi(s: string): string {
  return s
    .replaceAll(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replaceAll(/\x1b[()][A-Za-z0-9]/g, '');
}

/**
 * Resolves the `coder` binary path for a given Coder environment. Falls back
 * to `coder` on PATH when the env has no explicit `binaryPath`.
 */
export function resolveCoderBinary(environmentId: string): string {
  const env = getEnvironment(environmentId);
  if (!env) {
    throw new Error(
      `Environment not found: ${environmentId}. Environment ids must be UUIDs — ` +
      `call list_environments to discover them.`,
    );
  }
  if (env.type !== 'coder') {
    throw new Error(
      `Environment "${env.name}" (id ${env.id}) is type "${env.type}", not "coder".`,
    );
  }
  try {
    const cfg = JSON.parse(env.config) as Record<string, unknown>;
    if (typeof cfg.binaryPath === 'string' && cfg.binaryPath.trim()) {
      return cfg.binaryPath.trim();
    }
  } catch { /* use default */ }
  return 'coder';
}

/**
 * Shared wrapper for `coder <verb> --output json` invocations. Handles the
 * execFile + buffering + JSON.parse + non-array guard so each call-site only
 * has to provide an entry-level mapper. Filtering out null mapper results
 * lets callers skip malformed entries without a separate pass.
 */
async function runCoderCliJson<T>(
  binaryPath: string,
  args: string[],
  errLabel: string,
  mapEntry: (entry: Record<string, unknown>) => T | null,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          log.error(`${errLabel} failed`, { error: err.message, stderr: String(stderr).slice(0, 500) });
          reject(new Error(stderr ? String(stderr).trim() : err.message));
          return;
        }
        try {
          const raw = JSON.parse(String(stdout || '[]')) as unknown;
          if (!Array.isArray(raw)) { resolve([]); return; }
          const out = raw
            .map((entry) => mapEntry(entry as Record<string, unknown>))
            .filter((v): v is T => v !== null);
          resolve(out);
        } catch (parseErr) {
          log.error(`Failed to parse ${errLabel} output`, { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
          reject(new Error('Failed to parse coder CLI output as JSON'));
        }
      },
    );
  });
}

/**
 * Runs `coder list --output json` for the given environment and returns the
 * parsed workspace summaries. Used by name-collision checks before calling
 * `createCoderWorkspace`.
 */
export async function listCoderWorkspaces(environmentId: string): Promise<CoderWorkspace[]> {
  const binaryPath = resolveCoderBinary(environmentId);
  return runCoderCliJson<CoderWorkspace>(binaryPath, ['list', '--output', 'json'], 'coder list', (w) => {
    const latestBuild = (w.latest_build as Record<string, unknown> | undefined) || {};
    // typeof guards so non-string fields degrade to '' / 'unknown' instead
    // of being String()'d into '[object Object]'.
    const name = typeof w.name === 'string' ? w.name : '';
    if (!name) return null;
    const ownerSource = w.owner_name ?? w.owner;
    const owner = typeof ownerSource === 'string' ? ownerSource : '';
    const statusSource = latestBuild.status ?? w.status;
    const status = typeof statusSource === 'string' ? statusSource : 'unknown';
    return { name, owner, status };
  });
}

/**
 * Runs `coder templates list --output json` and returns the parsed templates.
 * The coder CLI wraps each entry in a `Template` key, which this mapper
 * transparently unwraps.
 */
export async function listCoderTemplates(environmentId: string): Promise<CoderTemplate[]> {
  const binaryPath = resolveCoderBinary(environmentId);
  return runCoderCliJson<CoderTemplate>(binaryPath, ['templates', 'list', '--output', 'json'], 'coder templates list', (entry) => {
    const t = (entry.Template || entry) as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : '';
    if (!name) return null;
    const displayNameSource = t.display_name || t.name;
    const displayName = typeof displayNameSource === 'string' ? displayNameSource : '';
    const description = typeof t.description === 'string' ? t.description : '';
    const activeVersionId = typeof t.active_version_id === 'string' ? t.active_version_id : '';
    return { name, displayName, description, activeVersionId };
  });
}

/**
 * Fetch the Coder deployment URL and a short-lived session token so we can
 * call REST endpoints that have no CLI equivalent (e.g. rich-parameters).
 * Shared by the renderer IPC layer and the Helm MCP bridge — both need auth
 * to introspect template parameters before creating a workspace.
 */
function getCoderAuth(binaryPath: string): Promise<{ url: string; token: string }> {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ['whoami', '--output', 'json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) { reject(new Error('Failed to get Coder URL: ' + err.message)); return; }
      let url: string;
      try {
        const raw = JSON.parse(String(stdout));
        const entry = Array.isArray(raw) ? raw[0] : raw;
        url = String(entry.url || '').replace(/\/+$/, '');
      } catch { reject(new Error('Failed to parse coder whoami output')); return; }
      if (!url) { reject(new Error('Coder URL not found in whoami output')); return; }

      execFile(binaryPath, ['tokens', 'create', '--lifetime', '5m'], { timeout: 10_000 }, (err2, stdout2) => {
        if (err2) { reject(new Error('Failed to create Coder API token: ' + err2.message)); return; }
        const token = String(stdout2).trim();
        if (!token) { reject(new Error('Empty token from coder tokens create')); return; }
        resolve({ url, token });
      });
    });
  });
}

/**
 * Fetch the rich parameters for a template version — the set of knobs a caller
 * must supply (or accept defaults for) when creating a workspace. Previously
 * inlined in the renderer IPC handler; lifted here so the Helm MCP bridge can
 * expose the same data to a leader CLI without duplicating the REST plumbing.
 */
export async function getCoderTemplateParams(
  environmentId: string,
  templateVersionId: string,
): Promise<CoderTemplateParam[]> {
  const binaryPath = resolveCoderBinary(environmentId);
  const { url, token } = await getCoderAuth(binaryPath);

  const https = await import('node:https');
  const http = await import('node:http');
  const { URL } = await import('node:url');

  return new Promise<CoderTemplateParam[]>((resolve, reject) => {
    const endpoint = new URL(`/api/v2/templateversions/${templateVersionId}/rich-parameters`, url);
    const mod = endpoint.protocol === 'https:' ? https : http;

    const req = mod.get(endpoint.href, {
      headers: { 'Coder-Session-Token': token },
      timeout: 10_000,
      // Internal Coder deployments often use certs signed by a private CA
      // that Node doesn't trust. The coder CLI handles this via the system
      // store; we mirror that trust here for this authenticated request.
      rejectUnauthorized: false,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log.error('Coder rich-parameters API error', { status: res.statusCode, body: body.slice(0, 500) });
          reject(new Error(`Coder API returned ${res.statusCode}`));
          return;
        }
        try {
          const raw = JSON.parse(body) as unknown;
          if (!Array.isArray(raw)) { resolve([]); return; }
          const params: CoderTemplateParam[] = raw
            .filter((p: Record<string, unknown>) => !p.ephemeral)
            .map((p: Record<string, unknown>) => ({
              name: String(p.name ?? ''),
              displayName: String(p.display_name || p.name || ''),
              description: String(p.description ?? ''),
              type: String(p.type ?? 'string'),
              defaultValue: String(p.default_value ?? ''),
              required: Boolean(p.required),
              options: Array.isArray(p.options) ? p.options.map((o: Record<string, unknown>) => ({
                name: String(o.name ?? ''),
                value: String(o.value ?? ''),
              })) : [],
            }));
          resolve(params);
        } catch (parseErr) {
          log.error('Failed to parse rich-parameters response', { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
          reject(new Error('Failed to parse template parameters'));
        }
      });
    });
    req.on('error', (err: Error) => reject(new Error('Coder API request failed: ' + err.message)));
  });
}

/**
 * Spawns `coder create <name> --template <template> --yes --parameter k=v ...`
 * under a PTY (required on Windows even when every parameter is supplied —
 * `coder create` writes interactive prompts to the console handle).
 *
 * The optional `onProgress` callback receives each progress-ish line scraped
 * out of stdout so a caller can surface streaming updates (IPC progress event,
 * log, etc.) without needing to duplicate the PTY plumbing.
 */
export async function createCoderWorkspace(
  opts: CreateCoderWorkspaceOptions,
  onProgress?: (line: string) => void,
): Promise<CoderWorkspace> {
  const binaryPath = resolveCoderBinary(opts.environmentId);
  log.info('Creating Coder workspace', { template: opts.templateName, name: opts.workspaceName });

  let ptyMod: typeof import('node-pty');
  try { ptyMod = require('node-pty'); } catch {
    throw new Error('node-pty not available — cannot create Coder workspace');
  }

  // Auto-fill template defaults for any rich parameter the caller didn't
  // supply. Empirically, `coder create --yes` hangs silently when only SOME
  // rich parameters are provided — it neither prompts nor proceeds. The GUI
  // avoids this by always sending the full set (every parameter the template
  // defines, pre-filled with defaults); we mirror that behavior here so the
  // MCP caller only has to name the values it actually wants to override.
  const mergedParameters: Record<string, string> = { ...(opts.parameters || {}) };
  try {
    const templates = await listCoderTemplates(opts.environmentId);
    const tmpl = templates.find(t => t.name === opts.templateName);
    if (tmpl?.activeVersionId) {
      const tmplParams = await getCoderTemplateParams(opts.environmentId, tmpl.activeVersionId);
      for (const p of tmplParams) {
        if (!(p.name in mergedParameters)) {
          mergedParameters[p.name] = p.defaultValue;
        }
      }
      log.info('Auto-filled template defaults', {
        template: opts.templateName,
        supplied: Object.keys(opts.parameters || {}),
        filled: tmplParams.map(p => p.name).filter(n => !(n in (opts.parameters || {}))),
      });
    } else {
      log.warn('Could not auto-fill defaults: template not found in listCoderTemplates', {
        template: opts.templateName,
      });
    }
  } catch (err) {
    // Non-fatal: fall through with caller-provided params only. The
    // interactive-prompt detector below is the safety net if the partial
    // set leaves coder create in its hang-silently state.
    log.warn('Auto-fill template defaults failed', {
      template: opts.templateName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const args = ['create', opts.workspaceName, '--template', opts.templateName, '--yes',
    ...Object.entries(mergedParameters).flatMap(([name, value]) => ['--parameter', `${name}=${value}`]),
  ];

  const cmd = `${binaryPath} ${args.join(' ')}`;
  log.info('coder create via PTY', { bin: binaryPath, args });

  // Pre-flight: if the user configured an absolute binaryPath, verify it
  // exists before handing the string to node-pty. Node-pty's spawn can throw
  // an opaque synchronous error on Windows when the binary is missing — the
  // check here turns that into a diagnosable message that names the path.
  if (/[\\/:]/.test(binaryPath)) {
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Configured Coder binary not found: ${binaryPath}. ` +
        `Update the environment's binaryPath or unset it to fall back to "coder" on PATH.`,
      );
    }
  }

  return new Promise<CoderWorkspace>((resolve, reject) => {
    let proc: import('node-pty').IPty;
    try {
      proc = ptyMod.spawn(binaryPath, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (spawnErr) {
      // Node-pty on Windows surfaces a missing binary as a synchronous throw
      // with a message like "File not found:" (no path). Re-wrap with the
      // full command and a PATH excerpt so the caller can see both what
      // Tether tried to run and where it searched.
      const rawMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      const pathExcerpt = (process.env.PATH || '').split(/[;:]/).slice(0, 20).join(path.delimiter);
      log.error('coder create spawn failed', { error: rawMsg, command: cmd, pathExcerpt });
      reject(new Error(
        `coder create spawn failed: ${rawMsg || '<empty error>'} | cmd: ${cmd} | ` +
        `Likely cause: "${binaryPath}" is not on the Electron main process PATH. ` +
        `Set an absolute binaryPath on the Coder environment or add coder to PATH before launching Tether.`,
      ));
      return;
    }

    let output = '';
    let aborted = false;
    const progressRe = /==>|===|Planning|Initializing|Starting|Queued|Running|Setting up|Cleaning/;
    // Coder CLI's interactive prompt markers. If the template has required
    // rich parameters with no defaults and the caller didn't pass them, the
    // CLI prints one of these and then blocks on stdin forever — without
    // detection we'd hang until the 5-minute timeout fires. Match these and
    // bail out with a pointer at get_coder_template_params instead.
    const promptRe = /Enter a value|Select one of|\? .*:\s*$/;
    const paramNameRe = /^var\s+([a-zA-Z_][a-zA-Z0-9_-]*)/;
    const promptedParams = new Set<string>();

    const timeout = setTimeout(() => {
      aborted = true;
      try { proc.kill(); } catch { /* already dead */ }
      reject(new Error('Workspace creation timed out after 5 minutes'));
    }, 300_000);

    proc.onData((data: string) => {
      output += data;
      const cleanedChunk = stripAnsi(data);
      for (const line of cleanedChunk.split(/[\r\n]+/)) {
        const clean = line.trim();
        if (!clean) continue;
        if (onProgress && progressRe.test(clean)) onProgress(clean);
        const paramMatch = clean.match(paramNameRe);
        if (paramMatch) promptedParams.add(paramMatch[1]);
        if (!aborted && promptRe.test(clean)) {
          aborted = true;
          clearTimeout(timeout);
          try { proc.kill(); } catch { /* already dead */ }
          const suppliedNames = Object.keys(opts.parameters || {});
          const missing = [...promptedParams].filter(n => !suppliedNames.includes(n));
          const missingHint = missing.length
            ? `Detected unsupplied parameters: ${missing.join(', ')}.`
            : `Could not identify the specific parameter from the prompt text.`;
          log.error('coder create blocked on interactive prompt', {
            command: cmd,
            promptLine: clean,
            detectedParams: [...promptedParams],
            suppliedParams: suppliedNames,
          });
          reject(new Error(
            `coder create is waiting on an interactive parameter prompt ("${clean}"). ` +
            `${missingHint} Call get_coder_template_params with the template's activeVersionId ` +
            `to list required parameters, then pass them via the "parameters" map on ` +
            `create_coder_workspace. | cmd: ${cmd}`,
          ));
          return;
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      // If we already rejected (prompt detected, timeout fired), the onExit
      // that follows our proc.kill() must not double-settle the Promise.
      if (aborted) return;
      if (exitCode !== 0) {
        // Build a single-line error that survives the error.message round-trip
        // through the Helm bridge and the MCP client. Include the exit code,
        // the invocation, and a bounded tail of the cleaned output — the
        // heuristic "first matching line" was losing context whenever the
        // Coder CLI split the error across lines or wrapped the path in
        // escape sequences the old regex didn't strip.
        const cleaned = stripAnsi(output);
        const lines = cleaned.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
        const errLine = lines.findLast(l => /error:|failed/i.test(l)) || lines[lines.length - 1] || '';
        const tail = lines.slice(-8).join(' | ');
        const parts = [`coder create failed (exit ${exitCode})`];
        if (errLine) parts.push(`: ${errLine}`);
        parts.push(` | cmd: ${cmd}`);
        if (tail && tail !== errLine) parts.push(` | tail: ${tail}`);
        const msg = parts.join('').slice(0, 4000);
        log.error('coder create failed', {
          exitCode,
          command: cmd,
          errLine,
          output: cleaned.slice(-2000),
        });
        reject(new Error(msg));
        return;
      }
      log.info('Coder workspace created', { name: opts.workspaceName });
      resolve({
        name: opts.workspaceName,
        owner: 'me',
        status: 'starting',
      });
    });
  });
}
