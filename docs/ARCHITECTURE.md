# Architecture Design — Tether

## System Overview

Tether is an Electron desktop application with a React frontend. The Electron main process owns all session lifecycle (PTY management, SSH connections, state persistence). The renderer process owns the UI (sidebar, terminal panels, configuration). Communication between them uses Electron IPC for both commands and real-time PTY data streaming.

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer Process (React + xterm.js)                        │
│  ┌──────────┐  ┌──────────────────────────┐  ┌───────────┐ │
│  │ Sidebar   │  │ Terminal Panel            │  │ Config    │ │
│  │ (sessions │  │ (xterm.js per session,    │  │ (env/     │ │
│  │  grouped  │  │  only active one visible) │  │  session  │ │
│  │  by env)  │  │                           │  │  settings)│ │
│  └──────────┘  └──────────────────────────┘  └───────────┘ │
│         │              ▲  │                        │        │
│         └──────────────┼──┼────────────────────────┘        │
│                  IPC   │  │  IPC                            │
├─────────────────────────┼──┼────────────────────────────────┤
│  Main Process           │  │                                │
│  ┌──────────────────────┼──┼──────────────────────────────┐ │
│  │ Session Manager      │  ▼                              │ │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────────┐ │ │
│  │  │ Session      │  │ Transport  │  │ Status Detector │ │ │
│  │  │ Registry     │  │ Adapters   │  │ (passive tap)   │ │ │
│  │  │ (JSON file)  │  │            │  │                 │ │ │
│  │  └─────────────┘  │ ┌────────┐ │  └─────────────────┘ │ │
│  │                    │ │ Local  │ │                      │ │
│  │                    │ │ SSH    │ │                      │ │
│  │                    │ └────────┘ │                      │ │
│  │                    └────────────┘                      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Component Design

### Session Registry

**Purpose:** Single source of truth for all session and environment state.

**Storage:** JSON file at `{app.getPath('userData')}/data.json`. Data is loaded into memory on first access and written to disk on mutations. SQLite was originally planned but deferred due to native module ABI issues with VS 2025 + Electron 41.

**Data schema (TypeScript interfaces in `src/main/db/database.ts`):**

```typescript
// Top-level data file structure
interface DbData {
  environments: EnvironmentRow[]
  sessions: SessionRow[]
  config: Record<string, string>           // Key-value config (theme, reposRoot, restoreOnLaunch)
  defaultEnvVars: Record<string, string>   // App-wide env vars
  defaultCliFlags: string[]                // App-wide CLI flags
  savedWorkspace: SavedWorkspace | null    // Session restore state
}

// EnvironmentRow
interface EnvironmentRow {
  id: string                   // UUID
  name: string
  type: 'local' | 'ssh' | 'coder'
  config: string               // JSON blob — host, port, username, etc.
  env_vars: string             // JSON-encoded Record<string, string>
  auth_mode: string | null     // Placeholder for future auth modes
  api_key_enc: string | null   // Placeholder for encrypted API key
  model: string | null         // Placeholder for model selection
  small_model: string | null   // Placeholder for small/fast model
  sort_order: number
  created_at: string           // ISO timestamp
  updated_at: string           // ISO timestamp
}

// SessionRow
interface SessionRow {
  id: string                   // UUID
  environment_id: string | null
  label: string
  working_dir: string
  state: string                // SessionState enum value
  auth_mode: string | null     // Placeholder
  api_key_enc: string | null   // Placeholder
  model: string | null         // Placeholder
  small_model: string | null   // Placeholder
  pid: number | null           // Local PTY PID
  sort_order: number
  created_at: string           // ISO timestamp
  updated_at: string           // ISO timestamp
  last_active_at: string | null
}
```

**Notes:**
- Environment variable config cascades: app defaults -> environment -> session overrides.
- `auth_mode`, `api_key_enc`, `model`, and `small_model` fields exist as placeholders for future auth/model selection features. Currently unused.
- `state` is updated by the Status Detector, not by the transport adapters directly.
- `pid` is only meaningful for local sessions. SSH sessions track connection state internally.
- On startup, `markAllRunningAsStopped()` resets any sessions left in running states from a previous crash.

### Session Manager

**Purpose:** Orchestrates session lifecycle and coordinates between the registry, transport adapters, and status detection.

**Responsibilities:**
- Create session: validate inputs → write to registry → spawn via adapter → start status detection
- Stop session: send SIGTERM to PTY → wait for graceful exit → update registry
- Kill session: send SIGKILL → clean up → update registry
- Reconnect session: re-establish transport (SSH reconnect, PTY reattach) → resume status detection
- Heartbeat loop: periodically check all sessions for liveness (PTY process alive? SSH channel open?)

**Session State Machine:**

```
                ┌──────────┐
                │ starting │
                └────┬─────┘
                     │ PTY spawned + first output
                     ▼
              ┌──────────────┐
         ┌───►│   running    │◄───┐
         │    └──────┬───────┘    │
         │           │            │
   output resumed    │      output resumed
         │           │            │
         │     ▼           ▼
    ┌────┴────┐    ┌──────────┐
    │  idle   │    │ waiting  │
    └─────────┘    └──────────┘
         │              │
         │    PTY exit / SSH drop
         │              │
         ▼              ▼
    ┌──────────────────────┐
    │    stopped / dead    │
    └──────────────────────┘
```

- `starting` → PTY spawn in progress, no output yet
- `running` → Claude Code is producing output (streaming response, running tools)
- `waiting` → Claude Code is showing the input prompt, waiting for user
- `idle` → No output for >30s (background, compacting, or user walked away)
- `stopped` → Graceful shutdown (user-initiated)
- `dead` → Unexpected exit, SSH disconnect, or force-killed

### Transport Adapters

All adapters implement a common interface (detailed in [Transport Design](TRANSPORT_DESIGN.md)).

**Local Adapter**
- Spawns Claude Code via `node-pty` with configured env vars
- PTY process is a direct child of the Electron main process
- Resize events propagated via `pty.resize(cols, rows)`
- Survives Electron renderer crashes (PTY lives in main process)

**SSH Adapter**
- Connects via `ssh2` library
- Opens a PTY channel (`session.shell()` with pty option)
- Spawns Claude Code as the shell command on the remote host
- Handles reconnection on network interruption (with configurable retry)
- Requires Claude Code to be pre-installed on the remote host

**Container Adapter (Future)**
- The `coder` environment type exists in the schema but currently falls back to `LocalTransport`
- Planned approach: SSH-via-Coder-CLI (Phase 7)
- No Docker adapter is planned — Coder is the target container runtime

### Status Detector

**Purpose:** Passively observe PTY output to infer session state without modifying the stream.

**Approach:** A tap on the data stream that runs pattern heuristics. The full, unmodified data always flows through to xterm.js first; the detector receives a copy.

**Heuristics (not parsing — pattern matching on output cadence):**

| Signal | Detection Method | State |
|---|---|---|
| Bytes flowing | Any data received in last 3s | `running` |
| Input prompt | Output pause + last bytes match prompt patterns | `waiting` |
| Extended silence | No data for 30s+ | `idle` |
| PTY exit event | `pty.onExit` / SSH channel close | `stopped` or `dead` |
| Error output | Exit code != 0 | `dead` |

**Important:** The detector does NOT attempt to parse ANSI escape sequences or understand Claude Code's UI structure. It operates on timing and byte-level patterns only. This makes it resilient to Claude Code UI changes across versions.

**Debounce:** State transitions are debounced (e.g., 500ms delay before transitioning from `running` to `waiting`) to avoid flickering during brief pauses in output.

### IPC Design

**Renderer -> Main (invoke/handle):**
- `session:create` — create a new session
- `session:list` — list all sessions
- `session:stop` — graceful stop (sends Ctrl+C)
- `session:kill` — force kill session
- `session:rename` — rename a session
- `session:remove` — remove session from list
- `environment:list` — list all environments
- `environment:create` — create a new environment
- `environment:update` — update environment config
- `environment:delete` — delete an environment
- `workspace:save` — save current workspace state
- `workspace:load` — load saved workspace
- `dialog:open-directory` — open OS directory picker
- `scan:repos-dir` — scan a directory for subdirectories (repo quick-pick)
- `config:get` / `config:set` — key-value config (theme, reposRoot, restoreOnLaunch)
- `config:get-default-env-vars` / `config:set-default-env-vars` — app-wide env vars
- `config:get-default-cli-flags` / `config:set-default-cli-flags` — app-wide CLI flags
- `titlebar:update` — update titlebar overlay color for theme sync

**Renderer -> Main (send/on — fire-and-forget):**
- `session:input` — send keystroke data to session PTY
- `session:resize` — resize PTY dimensions

**Main -> Renderer (events):**
- `session:data` — { sessionId, data } (raw PTY bytes — high frequency)
- `session:state-change` — { sessionId, state } (status detector updates)
- `session:exited` — { sessionId, exitCode } (PTY exit notification)

**Data streaming consideration:** PTY data (`session:data`) is the highest-frequency event. For local sessions this can be thousands of events per second during heavy output. Electron IPC handles this fine for a single active session, but if we're streaming data for background sessions (for status detection), we need to be mindful of IPC overhead. The main process should only send `session:data` for the **currently visible session** to the renderer. Background session data is consumed only by the status detector in the main process.

### Configuration & Storage

**All data is stored in a single JSON file:** `{app.getPath('userData')}/data.json`

This file contains:
- Environment definitions (Local, SSH, Coder)
- Session records (metadata, not terminal output)
- App config (theme, reposRoot, restoreOnLaunch)
- Default environment variables and CLI flags
- Saved workspace state (for session restore on launch)

**SSH keys:** Tether does not store or manage SSH keys. It references the user's existing SSH key paths (e.g., `~/.ssh/id_ed25519`). SSH agent forwarding is supported — on Windows, uses `\\.\pipe\openssh-ssh-agent`.

**Secrets handling:** API keys injected via environment variables are stored as plain text in the env var config. Encrypted storage via `safeStorage` is a placeholder in the schema (`api_key_enc` field) but not yet implemented.

## Key Design Decisions

### Why Electron (not Tauri, not web-only)

- `node-pty` requires Node.js native bindings — Tauri's Rust backend would need a different PTY library and the xterm.js integration is less proven.
- Electron's main process model maps perfectly to our architecture: PTYs live in main (long-lived, survives renderer reloads), UI lives in renderer.
- xterm.js is built for Electron/browser environments. The VS Code terminal stack (xterm.js + node-pty) is the most battle-tested terminal-in-an-app implementation available.
- Electron's IPC is fast enough for PTY data streaming (proven by VS Code).

### Why JSON Persistence (originally planned SQLite)

SQLite via `better-sqlite3` was the original plan for its atomic writes and query capabilities. However, native module ABI incompatibilities between VS 2025 and Electron 41 made `better-sqlite3` impractical to build. JSON file persistence was adopted as a pragmatic workaround:

- Zero native dependencies — no ABI issues
- Simple to debug (human-readable file)
- In-memory object with save-on-mutate is fast enough for the current scale
- `better-sqlite3` remains in `package.json` for future migration when toolchain issues are resolved

### Why not the Claude Agent SDK for session management

The Agent SDK is designed for programmatic agent orchestration — sending prompts, receiving structured responses, managing tool calls. Tether's use case is fundamentally different: we need a raw PTY stream for an interactive terminal, not a structured API. The SDK would give us a different (non-terminal) interaction model that loses the native feel. We use the Claude Code CLI binary directly, spawned in a PTY.

The SDK could be useful later for features like "send a prompt to a background session programmatically" but it's not the right foundation for the core terminal experience.
