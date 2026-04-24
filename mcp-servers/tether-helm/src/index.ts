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
    'a child to do the work. If environmentId is not known, call list_environments',
    'first. For Coder environments, ensure the target workspace exists first —',
    'use list_coder_workspaces and create_coder_workspace if needed.',
    'Launch profiles: if neither profileId nor profileName is set and the user has a',
    'default launch profile configured, it is applied automatically (same behavior',
    'as the GUI) — this is how API keys and model env vars travel into the child.',
    'Call list_profiles to see what\'s available or to find a non-default to pick;',
    'pass noProfile=true to opt out entirely.',
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
        description: 'Where the session lands. Semantics depend on environment type: (a) Local/SSH — a filesystem path (absolute, or `~/...`). (b) Coder — the WORKSPACE NAME (e.g. "pbi-93960"), NOT a filesystem path. Optionally append `::<subdir>` to cd into a path inside the Coder workspace after connecting (e.g. "pbi-93960::repo"). If omitted, Tether uses the parent session\'s workingDir — for Coder parents this is the workspace name, which is usually what you want when spawning siblings into the same workspace.',
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
        description: 'Environment variables to set on the child process. Merged ON TOP of any profile-provided env vars, so these are one-off overrides — prefer a launch profile for anything the user sets repeatedly.',
      },
      profileId: {
        type: 'string',
        description: 'Optional launch profile id (from list_profiles). Applies the profile\'s env vars (including API keys) and CLI flags to the child. Takes precedence over profileName.',
      },
      profileName: {
        type: 'string',
        description: 'Optional launch profile name. Resolved to an id via list_profiles. Fails if the name does not match any profile.',
      },
      noProfile: {
        type: 'boolean',
        description: 'Set true to skip the user\'s default launch profile. Default false — when neither profileId nor profileName is given, the default profile is applied automatically.',
      },
    },
  },
} as const;

const CREATE_CODER_WORKSPACE_TOOL = {
  name: 'create_coder_workspace',
  description: [
    'Create a fresh Coder workspace from a template. Any rich parameters you do not',
    'supply are auto-filled with the template\'s defaults (mirroring the Tether GUI)',
    'so a minimal call just needs environmentId, templateName, and workspaceName.',
    'Use get_coder_template_params if you need to override specific values — pass',
    'them in `parameters` and the rest will still be defaulted for you. If a',
    'template has a required parameter with no default, supply it explicitly or',
    '`coder create` will fail when the workspace plan validates. Typical flow for a',
    'PBI: list_coder_workspaces (dedupe) → create_coder_workspace → spawn_session',
    'into it.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId', 'templateName', 'workspaceName'],
    properties: {
      environmentId: {
        type: 'string',
        description: 'Tether environment id for the Coder deployment. Must be a UUID — use list_environments to discover.',
      },
      templateName: {
        type: 'string',
        description: 'Coder template name (the `name` field from list_coder_templates, not `displayName`). Skill picks based on PBI metadata.',
      },
      workspaceName: {
        type: 'string',
        description: 'New workspace name. Lowercase, hyphenated, starts with a letter (e.g. "pbi-1234").',
      },
      parameters: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Overrides for the template\'s rich parameters. Only list the ones you want to set differently from the template default — unspecified parameters are auto-filled with the template defaults before launching `coder create`. Use get_coder_template_params first if you need to see what\'s available.',
      },
    },
  },
} as const;

const LIST_CODER_WORKSPACES_TOOL = {
  name: 'list_coder_workspaces',
  description: [
    'List all Coder workspaces in a Coder environment. Use before create_coder_workspace',
    'to avoid duplicate-workspace errors when the skill re-runs for a PBI that already',
    'has an active workspace. Returns name, owner, and current status. If environmentId',
    'is not known, call list_environments first — the argument must be a UUID, not a',
    'display name.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId'],
    properties: {
      environmentId: { type: 'string', description: 'Tether environment id for the Coder deployment. Must be a UUID — use list_environments to discover.' },
    },
  },
} as const;

const LIST_CODER_TEMPLATES_TOOL = {
  name: 'list_coder_templates',
  description: [
    'List the Coder templates available in a Coder environment. Call this before',
    'create_coder_workspace when the template slug is not known — the returned `name`',
    'field is what create_coder_workspace expects as templateName (not `displayName`,',
    'which is only for humans). The `activeVersionId` field feeds',
    'get_coder_template_params so you can discover required rich parameters before',
    'creating. If environmentId is not known, call list_environments first.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId'],
    properties: {
      environmentId: { type: 'string', description: 'Tether environment id for the Coder deployment. Must be a UUID — use list_environments to discover.' },
    },
  },
} as const;

const GET_CODER_TEMPLATE_PARAMS_TOOL = {
  name: 'get_coder_template_params',
  description: [
    'List the rich parameters a Coder template version exposes. create_coder_workspace',
    'auto-fills defaults for every parameter, so you only need this tool when you want',
    'to override specific values or confirm what a required-with-no-default parameter',
    'expects. Returns name, displayName, description, type, defaultValue, required, and',
    '`options` (for enum-style parameters; use one of the `value` fields when overriding).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['environmentId', 'templateVersionId'],
    properties: {
      environmentId: { type: 'string', description: 'Tether environment id for the Coder deployment. Must be a UUID — use list_environments to discover.' },
      templateVersionId: { type: 'string', description: 'The template\'s `activeVersionId` as returned by list_coder_templates.' },
    },
  },
} as const;

const LIST_ENVIRONMENTS_TOOL = {
  name: 'list_environments',
  description: [
    'List all environments configured in Tether. Use this first when the caller does',
    'not know the environmentId for spawn_session or any of the Coder tools. Returns',
    'id, name, and type ("local" | "ssh" | "coder") for each — no auth, no secrets.',
    'The `id` field is the UUID required by every other tool here.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {},
  },
} as const;

const LIST_PROFILES_TOOL = {
  name: 'list_profiles',
  description: [
    'List the user\'s launch profiles. A launch profile is a reusable bundle of env',
    'vars (including API keys, often as `vault://` references) and CLI flags that',
    'gets applied to a session at launch. If a profile is marked isDefault=true it is',
    'applied automatically by spawn_session unless the caller passes noProfile=true.',
    'Returns id, name, isDefault, and `envVarKeys` — the KEYS of env vars that would',
    'be applied (values are never exposed over the bridge). Use this when you need to',
    'pick a non-default profile (profileId/profileName on spawn_session) or confirm',
    'that the default will supply expected credentials.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {},
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
  LIST_CODER_TEMPLATES_TOOL,
  GET_CODER_TEMPLATE_PARAMS_TOOL,
  LIST_ENVIRONMENTS_TOOL,
  LIST_PROFILES_TOOL,
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
