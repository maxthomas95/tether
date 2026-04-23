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
 * dials back to Tether's per-session helm bridge, and forwards each MCP tool
 * call to a bridge RPC of the same name.
 *
 * Tools are transparent pass-throughs — the main process owns all policy,
 * validation, and side effects. This server's job is to translate MCP
 * call/response into the bridge's line-delimited JSON protocol.
 */

const SPAWN_SESSION_TOOL = {
  name: 'spawn_session',
  description: [
    'Dispatch a new Tether session, pre-briefed with an initial prompt. The child',
    'session appears in Tether\'s sidebar under the target environment and can be',
    'taken over at any time. Typical use: a dispatcher skill reads a work item',
    '(e.g. an ADO PBI or GitHub issue), composes a structured brief, and spawns',
    'a child to do the work. For Coder environments, ensure the target workspace',
    'exists first — use list_coder_workspaces and create_coder_workspace if needed.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId', 'label', 'initialPrompt'],
    properties: {
      environmentId: {
        type: 'string',
        description: 'Tether environment id where the child session will run.',
      },
      workingDir: {
        type: 'string',
        description: 'Optional working directory inside the environment. If omitted, Tether uses the parent session\'s working dir.',
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
        description: 'Extra CLI flags to append to the child\'s launch command.',
      },
      envVars: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Environment variables to set on the child process.',
      },
    },
  },
} as const;

const CREATE_CODER_WORKSPACE_TOOL = {
  name: 'create_coder_workspace',
  description: [
    'Create a fresh Coder workspace from a template. Call list_coder_workspaces first',
    'if you want dedupe — if a workspace with the same name already exists, this tool',
    'errors. Typical flow for a PBI: list → check for existing "pbi-1234" workspace →',
    'create only if missing → spawn_session into it. Blocks until the workspace',
    'finishes provisioning (up to 5 min).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId', 'templateName', 'workspaceName'],
    properties: {
      environmentId: {
        type: 'string',
        description: 'Tether environment id for the Coder deployment.',
      },
      templateName: {
        type: 'string',
        description: 'Coder template name to use (e.g. "backend-dev", "frontend-dev"). Skill picks based on PBI metadata.',
      },
      workspaceName: {
        type: 'string',
        description: 'New workspace name. Lowercase, hyphenated, starts with a letter (e.g. "pbi-1234").',
      },
      parameters: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Template-specific parameters (rich parameters the template defines). Values are passed as --parameter k=v to coder CLI.',
      },
    },
  },
} as const;

const LIST_CODER_WORKSPACES_TOOL = {
  name: 'list_coder_workspaces',
  description: [
    'List all Coder workspaces in a Coder environment. Use before create_coder_workspace',
    'to avoid duplicate-workspace errors when the skill re-runs for a PBI that already',
    'has an active workspace. Returns name, owner, and current status.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId'],
    properties: {
      environmentId: { type: 'string', description: 'Tether environment id for the Coder deployment.' },
    },
  },
} as const;

const GET_SESSION_STATUS_TOOL = {
  name: 'get_session_status',
  description: [
    'Return the current state (running/idle/waiting/stopped/dead) and metadata of a',
    'Tether session by id. Useful after spawn_session to confirm the child is alive,',
    'or to poll a dispatched session\'s progress without subscribing to events.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', description: 'Id returned by spawn_session.' },
    },
  },
} as const;

const KILL_SESSION_TOOL = {
  name: 'kill_session',
  description: [
    'Terminate a Tether session. By default asks the child CLI to exit gracefully;',
    'set graceful=false to kill the PTY immediately. The session stays in the sidebar',
    'until the user removes it — this just stops the running process.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', description: 'Id of the session to terminate.' },
      graceful: { type: 'boolean', description: 'Default true. Set false to hard-kill the PTY.' },
    },
  },
} as const;

const TOOLS = [
  SPAWN_SESSION_TOOL,
  CREATE_CODER_WORKSPACE_TOOL,
  LIST_CODER_WORKSPACES_TOOL,
  GET_SESSION_STATUS_TOOL,
  KILL_SESSION_TOOL,
];

const TOOL_NAMES: Set<string> = new Set(TOOLS.map(t => t.name));

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
    { name: 'tether-helm', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!TOOL_NAMES.has(req.params.name)) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments || {}) as Record<string, unknown>;
    const result = await bridge.call(req.params.name, args);
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
