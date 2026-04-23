#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridge-client.js';

/**
 * tether-helm MCP server.
 *
 * Spawned by Claude Code as a stdio MCP child when a Tether session has the
 * Helm flag on. Reads TETHER_HELM_SOCKET + TETHER_HELM_TOKEN from its env,
 * dials back to Tether's per-session helm bridge, and exposes one tool for v0:
 *
 *   spawn_session — dispatch a new pre-briefed Tether session.
 *
 * All decisions about WHAT to dispatch live in the calling skill. This server
 * is a thin pass-through — it does no policy, no templating, no retries.
 */

const SPAWN_SESSION_TOOL = {
  name: 'spawn_session',
  description: [
    'Dispatch a new Tether session, pre-briefed with an initial prompt. The child',
    'session appears in Tether\'s sidebar under the target environment and can be',
    'taken over at any time. Typical use: a dispatcher skill reads a work item',
    '(e.g. an ADO PBI or GitHub issue), composes a structured brief, and spawns',
    'a child to do the work.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId', 'label', 'initialPrompt'],
    properties: {
      environmentId: {
        type: 'string',
        description: 'Tether environment id where the child session will run. Must already exist (v0 does not create Coder workspaces on the fly).',
      },
      workingDir: {
        type: 'string',
        description: 'Optional working directory inside the environment. If omitted, Tether uses the environment\'s default.',
      },
      label: {
        type: 'string',
        description: 'Sidebar label for the child session. Convention: use the ticket id (e.g. "ADO PBI-1234", "Issue #42") so Tether\'s sidebar becomes a live view of in-flight work.',
      },
      initialPrompt: {
        type: 'string',
        description: 'Structured brief passed as the child CLI\'s first user message. Include the ticket context, the goal, and any constraints the child needs up front.',
      },
      autoMode: {
        type: 'boolean',
        description: 'When true, launch the child in auto mode (skip per-tool-call approval prompts). Use with care — the child will act autonomously on the brief.',
      },
      cliFlags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra CLI flags to append to the child\'s launch command (Claude Code, Codex, etc.).',
      },
      envVars: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Environment variables to set on the child process.',
      },
    },
  },
} as const;

async function main(): Promise<void> {
  const socketPath = process.env.TETHER_HELM_SOCKET;
  const token = process.env.TETHER_HELM_TOKEN;

  if (!socketPath || !token) {
    process.stderr.write(
      '[tether-helm] Missing TETHER_HELM_SOCKET or TETHER_HELM_TOKEN env vars. ' +
      'This MCP server is spawned by Tether — do not run it standalone.\n',
    );
    process.exit(1);
  }

  const bridge = new BridgeClient();
  try {
    await bridge.connect(socketPath, token);
  } catch (err) {
    process.stderr.write(
      `[tether-helm] Failed to connect to Tether bridge at ${socketPath}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'tether-helm', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SPAWN_SESSION_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'spawn_session') {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments || {}) as Record<string, unknown>;
    const result = await bridge.call('spawn_session', args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: Claude Code closes stdio on session exit, which will
  // close the transport. Dispose the bridge so the tether side can clean up.
  process.on('SIGINT', () => { bridge.dispose(); process.exit(0); });
  process.on('SIGTERM', () => { bridge.dispose(); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(
    `[tether-helm] Fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});
