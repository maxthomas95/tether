# Architecture — Tether

## System Overview

Tether is an Electron + React + TypeScript desktop application for managing agent CLI sessions across Local, SSH, and Coder environments.

**Dumb pipe, smart shell:** the terminal stream reaches xterm.js unchanged. Status, hooks, usage, and notifications are passive side channels; they do not render or rewrite CLI output.

```text
Renderer: React UI + xterm.js
  input / resize / commands ──IPC──► Main: session manager + transports
  terminal output / state   ◄─IPC──  Local node-pty / ssh2 / coder ssh
```

Main owns transports, persistence, credentials, host-key verification, usage/quota, notifications, updates, and integrations. The renderer owns dialogs, sidebar state, terminal instances, pane layouts, shortcuts, and themes. [Transport Design](TRANSPORT_DESIGN.md) describes the adapter contract and launch boundaries.

## Source Map

| Area | Authoritative source |
|------|----------------------|
| Main lifecycle and windows | `src/main/index.ts` |
| Session lifecycle and configuration cascade | `src/main/session/session-manager.ts` |
| Transport contract and adapters | `src/main/transport/` |
| CLI registry, resume args, common flag presets | `src/shared/cli-tools.ts` |
| IPC channel names | `src/shared/constants.ts` |
| IPC handler dispatch and domain modules | `src/main/ipc/` |
| Preload API | `src/preload/preload.ts`, `src/preload/docs-preload.ts` |
| Persistence schema and repositories | `src/main/db/` |
| Settings UI | `src/renderer/components/SettingsDialog.tsx` |
| Terminal lifetime and off-DOM buffers | `src/renderer/hooks/useTerminalManager.ts` |
| Pane layout | `src/renderer/lib/layout-tree.ts`, `src/renderer/hooks/useLayoutState.ts` |
| Shortcut defaults and overrides | `src/shared/keybindings.ts` |
| In-app help and renderer | `src/docs/`, `src/docs-renderer/` |

## Session Lifecycle

The session manager creates a transport, registers data/exit callbacks, resolves launch configuration, starts the CLI, and maintains session metadata. It cleans up transports, status timers, transcript watchers, and optional integrations on exit/removal.

Env vars merge as global defaults → environment → launch profile → session overrides. CLI flags concatenate as per-tool global defaults → per-tool profile flags → session flags, with selected inherited entries removable. Tokenization happens at the transport boundary.

Local Claude Code, Codex CLI, Copilot CLI, and OpenCode can resume a known conversation when its history exists. Custom binaries have no tool-specific resume integration. SSH and Coder do not use the local transcript picker.

A stop request delegates to the transport, then escalates if the session remains alive after the 3-second grace period. A second stop during that period forces a kill. Local/Coder stop terminates the local PTY; SSH sends Ctrl+C, then `exit`, and closes the connection. There is no automatic terminal reconnection or remote PTY reattachment.

### Session States

| State | Meaning |
|-------|---------|
| `starting` | Launch is in progress. |
| `running` | Output is flowing, or a hook-capable turn is active. |
| `waiting` | A completion/permission signal or silence fallback indicates attention is needed. |
| `idle` | The cadence fallback has observed extended silence. |
| `stopped` | Exit code zero or an explicitly completed stop. |
| `dead` | Nonzero exit or transport failure. |

Startup marks stale active registry entries stopped. It does not scan an app PID file for orphan CLI processes.

## Status Detection and Hooks

`src/main/status/status-detector.ts` observes a copy of the output and input timing. It recognizes OSC 9 notification sequences and BEL bytes as passive signals; neither is stripped from the terminal stream. It does not interpret prompt text or rebuild CLI screens.

For sessions without working hooks, the silence fallback moves to waiting after roughly 3 seconds and idle after 30 seconds, with a 500 ms transition debounce. BEL notifications are coalesced over 2 seconds.

For hook-capable Claude/Codex sessions, active turns suppress the normal silence fallback. Completion sets `waitingReason: 'idle'`; permission prompts set `waitingReason: 'permission'`. Hook transitions are immediate. A safety timeout handles missing completion hooks.

`src/main/cli-config/` installs additive Claude settings and Codex notify overlays, plus a token-authenticated hook bridge. Installation is opt-in through `cliHooksEnabled`. Local overlays are cleaned on shutdown and recovered after crashes. SSH additionally requires the environment's remote-hook opt-in, Node on the host, and a non-sudo environment. Coder remote hooks remain deferred.

## Terminal Lifetime and IPC

`session:data` is sent as positional arguments `(sessionId, data)`. State changes use `(sessionId, state, waitingReason)`; exits use `(sessionId, exitInfo)`. Input and resize are fire-and-forget messages. Other command handlers generally use invoke/handle.

Current main-process IPC forwards data for all sessions. The renderer retains background xterm.js instances off-DOM and reuses them across switching, splitting, swapping, and maximizing. Only visible panes attach to the DOM. Scrollback is held in memory and is not saved across app restarts.

This off-DOM buffering behavior matches `AGENTS.md`. Reducing background IPC in the future would need a separate buffering/replay design that preserves the raw stream and scrollback.

The preload exposes domain APIs for sessions, environments, workspace, config, profiles, Vault, usage/quota, providers/git, transcripts, Coder, notifications, keybindings, diagnostics, docs, and updates. Consult `constants.ts` and the preload for exact channels instead of maintaining a copied count. Updates expose check/open-release-page actions; there is no in-app download/install channel.

## Configuration and Persistence

App state is JSON at `{app.getPath('userData')}/data.json`. `src/main/db/database.ts` defines the schema. Repository mutations save through atomic temporary-file writes with fsync/rename and transient-lock retries. Corrupt data is moved aside for recovery.

The file contains:

- Environment and session metadata.
- Config values, global env vars, and per-tool default flags.
- Launch profiles and GitHub/ADO/Gitea provider records.
- Saved workspace and layout configuration, sidebar ordering, and recent projects.
- Usage summaries, budget-warning periods, known-host fingerprints, and shortcut overrides.

Session records do not contain a terminal-output archive. CLI transcripts remain in their own storage. Workspace restoration launches sessions again; it does not resume the original PTY process.

### Secrets

SSH private keys remain at user-selected paths. Stored SSH passwords, provider tokens, sensitive env vars, and secret-bearing settings use Electron `safeStorage`. Vault references remain references; main resolves them before launch. Non-sensitive configuration values remain plaintext.

Vault login uses browser OIDC. The token is cached encrypted in `data.json` along with identity/expiry metadata. Settings offers no token-file or pasted-token auth mode. Expiry warnings prompt the user to log in again; there is no automatic Vault-token renewal.

`src/main/diagnostics/` exports a scrubbed database, rotated logs, and a manifest. Scrubbing covers secret-bearing keys, encrypted values, recognized credential patterns, and credential-bearing URL fields; Vault references remain visible.

## Settings and User Interface

Settings has eight searchable sections: General, Appearance, Terminal, Sessions, Notifications, Shortcuts, Integrations, and Usage.

Most settings apply on **Save**. Theme changes preview and revert on Cancel. Actions with their own persistence paths (shortcuts, profiles/providers, known-host revocation, Vault auth/migration, J.O.B.S. Test now, and font resets) apply immediately. CLI status-hook changes require a Tether restart.

Seven themes and independent UI/terminal font settings are defined in the renderer. The default theme key is `mocha`; the theme labeled **Tether (Default Dark)** is another choice, not the startup default.

Pane splitting is opt-in, with maximum counts of 1, 2, or 4. Layout and session selection stay in the renderer. Keyboard defaults live in `src/shared/keybindings.ts`. Broadcast input is selected from pane headers and only fans out from a selected pane when at least two live targets are selected.

## Usage and Quota

`src/main/usage/` reads local Claude and Codex transcripts, aggregates session/global totals, and prices tokens with a bundled LiteLLM table. A cached table at `{userData}/litellm-prices.json` is refreshed at most daily.

The OpenCode usage path reads Crush's `crush.db` through built-in `node:sqlite`; it does not cover every OpenCode storage format. Copilot has resume/history support but no cost reader. SSH/Coder transcripts are not downloaded.

Usage UI includes session strips, a global footer, history rollups, CSV/JSON export, and optional daily/weekly budget warnings. Display toggles do not disable usage collection. Budget thresholds only warn.

`src/main/quota/quota-service.ts` separately queries Claude and Codex subscription quota using local login credentials. It starts about 5 seconds after launch and polls every 5 minutes when enabled. It may refresh Claude OAuth credentials. Its network calls are separate from transcript usage collection.

## Notifications and Updates

`src/main/notifications/notification-service.ts` handles waiting, idle, unexpected exit, and terminal-bell desktop notifications, with focus suppression and per-session muting. Clicking a desktop notification focuses its session.

Generic outbound webhooks have separate trigger preferences and an optional encrypted bearer token. Payloads contain session metadata, not terminal output or env vars. Session muting suppresses both desktop notifications and generic webhooks. J.O.B.S. narration is a separate integration.

Update checking runs once roughly 15 seconds after launch when enabled. Stable/beta selection controls which GitHub releases are considered. Notifications link to the release page; users download and install releases themselves.

## Optional Integrations

### Vault and Git Providers

Vault KV v2 resolution, the secret picker, OIDC login, and migration live in `src/main/vault/`. Git provider clients live in `src/main/git/providers/` and support browsing, cloning, and remote creation for GitHub, Azure DevOps, and Gitea.

### Helm

`src/main/helm/` creates a local authenticated bridge and MCP config for Claude Code. Both the global `allowHelm` setting and the session toggle must be on. Use a local Claude parent; the bridge and resource paths are not forwarded to remote parents. The MCP requires Node on PATH.

Tools can discover environments/profiles, dispatch children, query/kill sessions, and discover/create Coder workspaces. There is no generic message broker or scheduler. See [Helm help](../src/docs/helm.md) and `mcp-servers/tether-helm/src/index.ts`.

### J.O.B.S. Office

`src/main/jobs/` probes the configured server's `/healthz` once a minute. Auto-detection is on by default. If a built local checkout is configured and no instance answers, Tether can launch it with Node and stop that owned process on quit.

Remote SSH/Coder sessions are narrated through JOBS webhooks; local sessions are left to JOBS's own watcher. An Office pill and webview appear when detected. The guest has no preload or Node access.

## Design Decisions

- **Electron:** main-process Node APIs provide PTY/SSH integration while xterm.js supplies terminal emulation.
- **JSON persistence:** avoids a native database dependency for app state. A future usage-index migration can consider built-in `node:sqlite`; it is not the current app-state store.
- **Native CLI processes:** preserve interactive terminal behavior. Structured agent APIs are not a replacement for the PTY path.
- **Separate side channels:** hooks, usage, and notifications can improve status and visibility without changing terminal content.

Current user instructions live in [src/docs](../src/docs/). Historical specifications under [archive](archive/) are frozen references, not current implementation contracts.
