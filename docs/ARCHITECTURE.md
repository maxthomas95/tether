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
| Canvas layout | `src/renderer/components/CanvasLayout.tsx`, `src/shared/canvas-types.ts` |
| Workspace recipes and encrypted launch intent | `src/main/workspace-recipes/`, `src/main/session/launch-snapshots.ts` |
| Claude child discovery and remote reads | `src/main/claude/subagent-tracker.ts`, `src/main/claude/remote-subagents.ts` |
| Codex account/configuration and child runs | `src/main/codex/` |
| Optional Pip reactions and AI comments | `src/renderer/lib/pip-behavior.ts`, `src/main/pip/` |
| Shortcut defaults and overrides | `src/shared/keybindings.ts` |
| In-app help and renderer | `src/docs/`, `src/docs-renderer/` |

## Session Lifecycle

The session manager creates a transport, registers data/exit callbacks, resolves launch configuration, starts the CLI, and maintains session metadata. It cleans up transports, status timers, transcript watchers, and optional integrations on exit/removal.

Env vars merge as global defaults → environment → launch profile → session overrides. CLI flags concatenate as per-tool global defaults → per-tool profile flags → session flags, with selected inherited entries removable. Tokenization happens at the transport boundary.

Local Claude Code, Codex CLI, Copilot CLI, and OpenCode can resume a known conversation when its history exists. Custom binaries have no tool-specific resume integration. SSH and Coder do not use the local transcript picker.

Remote Claude/Codex restart and workspace restore use the saved native conversation ID, the same CLI user/home, and history on the same host/workspace. Claude receives an ID at launch; Codex discovery uses the passive remote usage connection. Missing Claude history starts a fresh conversation under the saved ID; Codex reports its own missing-history error. This restores context, not a process detached from the old terminal.

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

Local installation first checks standalone Node.js and records its absolute executable path. If it cannot run, Tether removes stale Tether entries, warns once, and retains cadence detection and user-owned hooks. Optional local Codex lifecycle hooks have another opt-in and require native Codex trust; observer events never approve requests or change tool results.

## Child-Agent Discovery

`claude/subagent-tracker.ts` combines hook events and incremental transcript reads into bounded child-row snapshots for local, SSH, and Coder Claude sessions. Remote reads use `usage/remote-probe-channels.ts`, with one resident reader per SSH environment/Coder workspace, separate from usage collection. Without hooks, status estimates activity from the last transcript change; a quiet child can appear finished.

`codex/exec-tracker.ts` attributes local `codex exec` lifecycle events to the Claude session whose launch environment they inherit. Exact thread IDs locate rollout files; these rows never change the parent's status. Remote exec rows and separate rows for Codex's own nested subagents are unavailable.

The list returns child metadata and a bounded task excerpt. Opening `ChildAgentViewer.tsx` explicitly reads that child's transcript into memory, with head/tail limits for long runs and incremental refresh. No child transcript is saved by Tether. **Show subagents in sidebar**, on by default, disables both local and remote child reads when turned off. Native children have read-only viewers; Helm children are separate Tether-managed PTY sessions.

## Terminal Lifetime and IPC

`session:data` is sent as positional arguments `(sessionId, data)`. State changes use `(sessionId, state, waitingReason)`; exits use `(sessionId, exitInfo)`. Input and resize are fire-and-forget messages. Other command handlers generally use invoke/handle.

Current main-process IPC forwards data for all sessions. The renderer retains background xterm.js instances off-DOM and reuses them across switching, splitting, swapping, and maximizing. Only visible panes attach to the DOM. Scrollback is held in memory and is not saved across app restarts.

Reducing background IPC in the future would need a separate buffering/replay design that preserves the raw stream and scrollback.

Terminal input encoding belongs in the renderer's terminal manager. Windows Shift+Enter follows the target CLI and its requested keyboard mode: Claude uses its Ctrl+J newline binding, while Codex retains native Windows key events. Broadcast encodes input independently for each selected target. Output remains unchanged. Clipboard writes and HTTP(S) link opening go through main-process IPC; OSC 52 reads are ignored, and OSC 8 links require Ctrl+click just like plain URLs.

The preload exposes domain APIs for sessions, environments, workspace, config, profiles, Vault, usage/quota, providers/git, transcripts, Coder, notifications, keybindings, diagnostics, docs, and updates. Consult `constants.ts` and the preload for exact channels instead of maintaining a copied count. Updates expose check/open-release-page actions; there is no in-app download/install channel.

## Configuration and Persistence

App state is JSON at `{app.getPath('userData')}/data.json`. `src/main/db/database.ts` defines the schema. Repository mutations save through atomic temporary-file writes with fsync/rename and transient-lock retries. Corrupt data is moved aside for recovery.

The file contains:

- Environment and session metadata.
- Config values, global env vars, and per-tool default flags.
- Launch profiles and GitHub/ADO/Gitea provider records.
- Saved workspace, split/Canvas layout configuration, named workspace recipes, sidebar ordering, and recent projects.
- Encrypted launch snapshots referenced by opaque IDs during restore, duplication, and recipe launches.
- Usage summaries, budget-warning periods, known-host fingerprints, and shortcut overrides.

Session records do not contain a terminal-output archive. CLI transcripts remain in their own storage. Workspace restoration launches sessions again; it does not resume the original PTY process.

Restore reapplies saved session overrides and the selected profile reference, using current global/environment/profile values and freshly resolved Vault references. Missing keys or deleted profiles fail before launch. Failed restore entries remain saved for retry until explicitly forgotten. Recipes validate selected slots before starting fresh sessions, can remap environments, and do not stop existing sessions.

### Secrets

SSH private keys remain at user-selected paths. Stored SSH passwords, provider tokens, all nonempty literal env-var values, secret-bearing settings, and launch snapshots use Electron `safeStorage`. Vault references remain references; main resolves them before launch. Ordinary non-secret settings remain plaintext. Legacy plaintext credentials migrate before the database opens; a failed migration preserves the original file and fails loading instead of writing a plaintext backup.

Vault login uses browser OIDC. The token is cached encrypted in `data.json` along with identity/expiry metadata. Settings offers no token-file or pasted-token auth mode. Expiry warnings prompt the user to log in again; there is no automatic Vault-token renewal.

`src/main/diagnostics/` exports a scrubbed database, rotated logs, and a manifest. Scrubbing covers secret-bearing keys, encrypted values, recognized credential patterns, and credential-bearing URL fields; Vault references remain visible.

## Settings and User Interface

Settings has nine searchable sections: General, Appearance, Terminal, Sessions, Notifications, Shortcuts, Integrations, CLI tools, and Usage.

Most settings apply on **Save**. Theme changes preview and revert on Cancel. Actions with their own persistence paths (shortcuts, profiles/providers, known-host revocation, Vault auth/migration, J.O.B.S. Test now, and font resets) apply immediately. CLI status-hook changes require a Tether restart.

Eleven themes and independent UI/terminal font settings are defined in the renderer, with bundled fonts, a live specimen preview, and comfortable/compact density. The default theme key is `mocha`; the theme labeled **Tether (Default Dark)** is another choice, not the startup default.

Pane splitting is opt-in, with maximum counts of 1, 2, or 4. Layout and session selection stay in the renderer. Keyboard defaults live in `src/shared/keybindings.ts`. Broadcast input is selected from pane headers and only fans out from a selected pane when at least two live targets are selected.

Canvas is an independent experimental layout with movable/resizable panels, panning, keyboard navigation, and persisted geometry. Offscreen panels detach their views and retain their terminal buffers. Entering Canvas clears broadcast targets. Terminal search reads the focused pane's scrollback without sending CLI input.

CLI tools settings provide per-tool defaults and guided launch options. `src/main/cli-maintenance/` runs explicit version/update commands in temporary terminals on local, SSH, or Coder targets; those terminals do not install hooks, collect usage, or become saved conversations.

## Usage and Quota

`src/main/usage/` reads local Claude/Codex transcripts and sanitized usage records from Tether-launched SSH/Coder conversations. Source-scoped cursors, request checkpoints, and model state avoid duplicate accounting after restart. Codex request records include compaction; reasoning is part of output, not an additional billed total. Daily buckets use UTC event dates. A bundled LiteLLM table and a cached daily refresh supply API-equivalent estimates, not subscription bills.

Remote usage uses separate authenticated command channels, independently of status hooks. SSH keeps a resident reader per connection; Coder usage runs a command per poll. Child discovery uses a second resident reader per SSH environment/Coder workspace. Elevated SSH may therefore authenticate a second reader. `usage/remote-auth-state.ts` serializes elevated starts and suspends further attempts after a refused login/password or a reader readiness timeout after sending the password. Editing the environment or successfully connecting a session clears that suspension. Other reader failures use retry/backoff.

The OpenCode usage path reads local Crush `crush.db` through built-in `node:sqlite`; it does not cover every OpenCode storage format. Copilot has resume/history support but no cost reader. Usage replies contain usage fields and source/cursor metadata. Child lists additionally return task metadata, and an opened child viewer fetches transcript lines into memory. Remote Node.js and Linux `/proc` access for automatic Codex discovery are required; see [remote usage requirements and privacy](../src/docs/usage-quota.md).

Usage UI includes session strips, a global footer, history rollups, CSV/JSON export, and optional daily/weekly budget warnings. Display toggles do not disable usage collection. Budget thresholds only warn.

`src/main/quota/quota-service.ts` polls enabled subscription quota every five minutes. Claude uses its local OAuth credentials and may refresh them; Codex uses the installed CLI's supported app-server interface rather than reading its auth tokens. Explicit account-usage/configuration actions live in `src/main/codex/`. Selected configuration fields and source categories are returned; raw credentials, hook commands, URLs, and env values are excluded. These requests are separate from transcript usage.

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

`src/main/jobs/` probes an enabled server's `/healthz` once a minute. New setups are off by default; explicitly saved integrations keep their previous behavior. Connection, remote-session sharing, and automatic launch have separate controls. If enabled with a built local checkout and no answering server, Tether can launch it with Node and stop only that owned process on quit.

When sharing is enabled, remote SSH/Coder session metadata is narrated through JOBS webhooks; local sessions are left to JOBS's own watcher. An Office pill and webview appear when connected. The guest is sandboxed, restricted to the configured origin, and has no preload or Node access.

### GIF Panel and Pip

The GIF panel reads only selected local image folders and ships no media. Pip's local reactions use session/focus metadata and a text-free typing signal. Both are off by default and pause hidden work/reduce motion as documented in [Settings](../src/docs/settings.md#appearance).

Pip AI comments are another opt-in, using a bounded temporary Codex conversation with ChatGPT sign-in. Activity-only context excludes paths, labels, draft text, and terminal output. Separate prompt-sharing consent permits a scrubbed, bounded excerpt from an attributed recent local Claude/Codex transcript. Tether saves neither excerpts nor generated comments. Failure or unavailable models fall back to local quips.

## Desktop Security and Packaging

Main and docs windows enable `sandbox`, `contextIsolation`, and disable Node integration. Preloads expose a bounded IPC API; main validates privileged calls and owns filesystem, clipboard, external links, credentials, and transport startup. Navigation/window-open guards and the renderer CSP remain enabled; runtime styles required by React/xterm are explicitly allowed.

Forge packages ASAR with unpacked node-pty/ssh2 resources. Helm and the CLI hook ship as real resource directories for external Node processes. Local/Coder Windows PTYs use bundled ConPTY DLL support so shutdown works with the `RunAsNode` fuse disabled. `scripts/verify-package.mjs` checks packaged imports, resources, native bindings, and preload constraints. Windows builds remain unsigned; validation and publication gates are in [RELEASE.md](../RELEASE.md).

## Design Decisions

- **Electron:** main-process Node APIs provide PTY/SSH integration while xterm.js supplies terminal emulation.
- **JSON persistence:** avoids a native database dependency for app state. A future usage-index migration can consider built-in `node:sqlite`; it is not the current app-state store.
- **Native CLI processes:** preserve interactive terminal behavior. Structured agent APIs are not a replacement for the PTY path.
- **Separate side channels:** hooks, usage, and notifications can improve status and visibility without changing terminal content.

Current user instructions live in [src/docs](../src/docs/). Historical specifications under [archive](archive/) are frozen references, not current implementation contracts.
