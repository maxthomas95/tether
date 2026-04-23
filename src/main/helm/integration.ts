import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createHelmBridge, type HelmBridgeHandlers } from './bridge';
import { createLogger } from '../logger';

const log = createLogger('helm-integration');

/**
 * Per-session Helm wiring: a listening bridge + a temp MCP config file that
 * points Claude Code at the tether-helm MCP server with the right env vars.
 *
 * The `--mcp-config <path>` CLI flag is appended to the CLI args by the
 * caller; this module just produces the path and owns the cleanup lifetime.
 */
export interface HelmIntegration {
  /** Path to append via `--mcp-config` on the child CLI's launch line. */
  mcpConfigPath: string;
  /** Closes the bridge and deletes the temp config file. Idempotent. */
  cleanup(): void;
}

/**
 * Resolve the MCP server launch command based on whether we're in a packaged
 * app or a dev run. Dev mode runs `node <repo>/mcp-servers/tether-helm/dist/index.js`
 * and requires the user to have built the subpackage. Packaged mode will use
 * a bundled `.exe` once we ship that (not wired yet — see Helm design v0 notes).
 */
function resolveHelmMcpCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    // Placeholder: we'll flip to the bundled .exe when Option (c) lands.
    // Until then, packaged builds have no Helm support.
    throw new Error(
      'Helm is not yet available in packaged builds. Run Tether via `npm run start` to use Helm.',
    );
  }
  // __dirname during dev is `.vite/build/`. Climb to repo root.
  const root = path.resolve(__dirname, '..', '..');
  const jsPath = path.join(root, 'mcp-servers', 'tether-helm', 'dist', 'index.js');
  if (!fs.existsSync(jsPath)) {
    throw new Error(
      `tether-helm MCP server not built. Run: ` +
      `npm --prefix mcp-servers/tether-helm install && ` +
      `npm --prefix mcp-servers/tether-helm run build`,
    );
  }
  return { command: 'node', args: [jsPath] };
}

/** Where per-session MCP configs live. One JSON per session id, cleaned on exit. */
function getConfigsDir(): string {
  const dir = path.join(app.getPath('userData'), 'helm-mcp-configs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function setupHelmForSession(
  sessionId: string,
  handlers: HelmBridgeHandlers,
): Promise<HelmIntegration> {
  const mcp = resolveHelmMcpCommand();
  const bridge = await createHelmBridge(sessionId, handlers);

  const config = {
    mcpServers: {
      'tether-helm': {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
        env: {
          TETHER_HELM_SOCKET: bridge.socketPath,
          TETHER_HELM_TOKEN: bridge.token,
        },
      },
    },
  };
  const configPath = path.join(getConfigsDir(), `${sessionId}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  log.info('Helm integration ready', { sessionId, configPath, socketPath: bridge.socketPath });

  let cleaned = false;
  return {
    mcpConfigPath: configPath,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      bridge.dispose();
      try { fs.unlinkSync(configPath); } catch { /* already gone */ }
      log.info('Helm integration torn down', { sessionId });
    },
  };
}
