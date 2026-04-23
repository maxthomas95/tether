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
│  │                    │ │ Coder  │ │                      │ │
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

**Local Adapter** (`local-transport.ts`)
- Spawns the configured CLI binary (`claude`, `codex`, `opencode`, or custom) via `node-pty` with configured env vars
- On Unix the binary is spawned directly; on Windows it goes through `cmd.exe /c` for proper PTY semantics
- CLI flag entries are tokenized on whitespace before spawn so multi-token presets like `--permission-mode plan` work
- PTY process is a direct child of the Electron main process
- Resize events propagated via `pty.resize(cols, rows)`
- Survives Electron renderer crashes (PTY lives in main process)

**SSH Adapter** (`ssh-transport.ts`)
- Connects via `ssh2` library with TOFU host key verification (`src/main/ssh/host-verifier.ts`) backed by `known-hosts-repo.ts`
- First-connect host keys surface a `HostKeyVerifyDialog`; subsequent connects fail closed if the key changes
- Optional sudo elevation on connect (configured per environment)
- Opens a PTY channel (`session.shell()` with pty option)
- Spawns the CLI as the shell command on the remote host
- UTF-8 chunk reassembly across network reads so split multi-byte glyphs don't render as replacement characters
- Requires the chosen CLI binary to be pre-installed on the remote host

**Coder Adapter** (`coder-transport.ts`)
- Connects to a Coder workspace via the Coder REST API + SSH-style PTY exec
- Two flows: connect to an existing workspace, or create a new workspace from a template (with parameter forms, live progress, and self-signed cert support)
- Workspace start is idempotent so workspace restarts don't fail re-clones

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

The IPC surface has grown to ~67 channels across these families (see `src/main/ipc/handlers.ts` for the full registry):

**Sessions:** `session:create`, `session:list`, `session:stop`, `session:kill`, `session:rename`, `session:remove`, plus per-session usage queries

**Environments:** `environment:list|create|update|delete`

**Workspace:** `workspace:save`, `workspace:load`

**Config:** `config:get|set` (key-value), per-tool default env vars / CLI flags, default settings

**Launch profiles:** `profile:list|create|update|delete` — named bundles of env vars + per-tool CLI flags

**Vault:** auth (token + OIDC), status/expiry, KV browse for the picker, `vault://` resolution

**Coder:** workspace list, template list, parameter introspection, create-workspace with progress streaming

**Git providers:** Azure DevOps and Gitea repo browse for the New Session dialog quick-pick

**Transcripts:** list and read Claude / Codex transcripts for the Resume Chat dialog

**SSH known hosts:** list / remove

**Updates:** `update:check`, `update:download`, `update:install`

**Dialogs and OS:** directory picker, repo dir scan, titlebar color sync

**Renderer -> Main (send/on — fire-and-forget):**
- `session:input` — send keystroke data to session PTY
- `session:resize` — resize PTY dimensions

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
- App config (theme, reposRoot, restoreOnLaunch, etc.)
- Default environment variables (per-tool) and CLI flags (per-tool)
- Launch profiles (named bundles of env vars + per-tool CLI flags)
- Git provider credentials (ADO, Gitea)
- SSH known-hosts entries
- Vault config (URL, namespace, auth mode)
- Saved workspace state (for session restore on launch) — written synchronously on every change so installs/restarts don't restore stale state

**SSH keys:** Tether does not store or manage SSH keys. It references the user's existing SSH key paths (e.g., `~/.ssh/id_ed25519`). SSH agent forwarding is supported — on Windows, uses `\\.\pipe\openssh-ssh-agent`.

**SSH host keys:** First-connect host keys are pinned via TOFU and stored in the registry (managed from Settings).

**Secrets handling:** Env var values can be literal strings or `vault://` references. Vault refs are resolved at session start by `vault-resolver.ts` so the secret is never persisted to `data.json`. Vault auth tokens live in OS keychain via Electron's `safeStorage`; OIDC flows open a browser and complete via local callback. The legacy plaintext-API-key path still exists for non-Vault users; encrypted at-rest storage for those values is still a placeholder.

### Vault Integration

`src/main/vault/` implements a HashiCorp Vault KV v2 client with token and OIDC auth. The renderer surfaces:
- A Vault status pill in the sidebar showing auth state and token TTL
- A `VaultPickerDialog` to browse Vault paths and pick a secret when authoring an env var
- A pre-session preflight that warns if any required `vault://` ref will fail to resolve
- A `MigrateToVaultDialog` to lift a plaintext value into Vault

### Usage and Quota Tracking

`src/main/usage/` and `src/main/quota/` are passive readers of the CLI tools' own session transcripts (Claude Code JSONL, Codex transcripts):
- `jsonl-parser.ts` extracts token usage events from transcripts
- `model-pricing.ts` maps tokens → cost per model
- `usage-service.ts` aggregates per-session and global usage
- `quota-service.ts` tracks subscription quota windows (Claude weekly resets, Codex daily resets)

Surfaced in the UI as a sidebar global usage footer (today's cost + 7-day sparkline), a per-session cost strip below each terminal pane, and an optional quota footer.

### Auto-Update

`src/main/update/update-checker.ts` polls GitHub Releases for newer versions and surfaces a notification in the renderer. The user opts in to download/install; the install is delegated to the OS installer.

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
