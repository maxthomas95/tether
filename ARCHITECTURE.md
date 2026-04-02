# Architecture Design — Tether

## System Overview

Tether is an Electron desktop application with a React frontend. The Electron main process owns all session lifecycle (PTY management, SSH connections, state persistence). The renderer process owns the UI (sidebar, terminal panels, configuration). Communication between them uses Electron IPC for commands and a WebSocket-style event channel for real-time PTY data streaming.

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
│  │  │ (SQLite)     │  │            │  │                 │ │ │
│  │  └─────────────┘  │ ┌────────┐ │  └─────────────────┘ │ │
│  │                    │ │ Local  │ │                      │ │
│  │                    │ │ SSH    │ │                      │ │
│  │                    │ │ Docker │ │                      │ │
│  │                    │ └────────┘ │                      │ │
│  │                    └────────────┘                      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Component Design

### Session Registry

**Purpose:** Single source of truth for all session and environment state.

**Storage:** SQLite via `better-sqlite3` (synchronous reads, async writes). Database file lives at `~/.Tether/sessions.db`.

**Schema (conceptual):**

```
environments
  id              TEXT PRIMARY KEY (uuid)
  name            TEXT NOT NULL
  type            TEXT NOT NULL (local | ssh | docker)
  config          TEXT NOT NULL (JSON blob — host, user, key, etc.)
  auth_mode       TEXT (subscription | api_key | openrouter — nullable, inherits app default)
  api_key_enc     TEXT (encrypted via safeStorage — nullable)
  model           TEXT (nullable — model identifier, format depends on auth_mode)
  small_model     TEXT (nullable — small/fast model identifier)
  sort_order      INTEGER
  created_at      TEXT
  updated_at      TEXT

sessions
  id              TEXT PRIMARY KEY (uuid)
  environment_id  TEXT REFERENCES environments(id)
  label           TEXT
  working_dir     TEXT NOT NULL
  state           TEXT NOT NULL (starting | running | waiting | idle | stopped | dead)
  auth_mode       TEXT (nullable — overrides environment)
  api_key_enc     TEXT (nullable — encrypted, overrides environment)
  model           TEXT (nullable — overrides environment)
  small_model     TEXT (nullable — overrides environment)
  pid             INTEGER (local PTY PID, nullable)
  sort_order      INTEGER
  created_at      TEXT
  updated_at      TEXT
  last_active_at  TEXT
```

**Notes:**
- Auth config cascades: session → environment → app defaults. A session's `auth_mode` overrides its environment's; null falls through to the next level. See [DD-02](DESIGN_DECISIONS.md#dd-02-auth-model--first-class-support-for-three-modes).
- `api_key_enc` is encrypted via Electron's `safeStorage` before storage. See [DD-04](DESIGN_DECISIONS.md#dd-04-secrets-storage-mvp).
- `model` format depends on `auth_mode`: Anthropic-native identifiers for `api_key` mode, OpenRouter-namespaced for `openrouter` mode. See [DD-03](DESIGN_DECISIONS.md#dd-03-naming-convention-for-openrouter-models).
- `state` is updated by the Status Detector, not by the transport adapters directly.
- `pid` is only meaningful for local sessions. SSH sessions track connection state internally.

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

**Container Adapter (Post-MVP)**
- Targets Docker Engine API or Coder API
- Creates/starts a container with Claude Code available
- Attaches to container exec session for PTY
- Can spin up ephemeral containers on demand

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

**Renderer → Main (commands):**
- `session:create` — { environmentId, workingDir, label, authMode?, apiKey?, model?, smallModel? }
- `session:stop` — { sessionId }
- `session:kill` — { sessionId }
- `session:switch` — { sessionId } (tells main to route PTY data for this session to renderer)
- `session:resize` — { sessionId, cols, rows }
- `session:input` — { sessionId, data } (keystrokes from xterm.js)
- `environment:create` — { name, type, config, apiConfig }
- `environment:update` — { id, ...changes }
- `environment:delete` — { id }
- `environment:test` — { id } (validate SSH connection, etc.)

**Main → Renderer (events):**
- `session:data` — { sessionId, data } (raw PTY bytes — high frequency)
- `session:state-change` — { sessionId, oldState, newState }
- `session:exited` — { sessionId, exitCode }
- `sessions:list` — { sessions[] } (initial load and refresh)
- `environments:list` — { environments[] }

**Data streaming consideration:** PTY data (`session:data`) is the highest-frequency event. For local sessions this can be thousands of events per second during heavy output. Electron IPC handles this fine for a single active session, but if we're streaming data for background sessions (for status detection), we need to be mindful of IPC overhead. The main process should only send `session:data` for the **currently visible session** to the renderer. Background session data is consumed only by the status detector in the main process.

### Configuration & Storage

**App config:** `~/.Tether/config.json`
- Default API settings (base_url, api_key, model)
- UI preferences (sidebar width, theme)
- Keyboard shortcut overrides

**Session database:** `~/.Tether/sessions.db`
- See schema above

**SSH keys:** Tether does not store or manage SSH keys. It references the user's existing SSH key paths (e.g., `~/.ssh/id_ed25519`). SSH agent forwarding is supported if the user's agent is running.

**Secrets handling:** API keys are encrypted at rest using Electron's `safeStorage` module (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Keys are encrypted before writing to SQLite and decrypted on read. See [DD-04](DESIGN_DECISIONS.md#dd-04-secrets-storage-mvp) for full rationale.

## Key Design Decisions

### Why Electron (not Tauri, not web-only)

- `node-pty` requires Node.js native bindings — Tauri's Rust backend would need a different PTY library and the xterm.js integration is less proven.
- Electron's main process model maps perfectly to our architecture: PTYs live in main (long-lived, survives renderer reloads), UI lives in renderer.
- xterm.js is built for Electron/browser environments. The VS Code terminal stack (xterm.js + node-pty) is the most battle-tested terminal-in-an-app implementation available.
- Electron's IPC is fast enough for PTY data streaming (proven by VS Code).

### Why SQLite (not JSON files, not a full DB)

- Atomic reads/writes without file corruption risk
- Query capability for filtering/sorting sessions
- `better-sqlite3` is synchronous for reads — no async overhead for sidebar renders
- Single file, zero config, survives app crashes
- Can easily export/backup by copying one file

### Why not the Claude Agent SDK for session management

The Agent SDK is designed for programmatic agent orchestration — sending prompts, receiving structured responses, managing tool calls. Tether's use case is fundamentally different: we need a raw PTY stream for an interactive terminal, not a structured API. The SDK would give us a different (non-terminal) interaction model that loses the native feel. We use the Claude Code CLI binary directly, spawned in a PTY.

The SDK could be useful later for features like "send a prompt to a background session programmatically" but it's not the right foundation for the core terminal experience.
