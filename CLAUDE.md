# CLAUDE.md — Tether

## Project Overview

Tether is a desktop session multiplexer for Claude Code and Codex CLI. It provides a single unified interface to manage multiple agentic CLI sessions across local, SSH, and Coder workspace environments — preserving the exact native terminal experience via raw PTY piping into xterm.js.

**Status:** Active development — in the 1.0 polish push. Currently on the `0.6.x` stable line (stable/beta update channels live). Local, SSH, and Coder transports working; multi-CLI support (Claude/Codex/Copilot/OpenCode/Custom); Vault-backed env vars; usage tracking with daily/weekly/monthly rollups, per-CLI and per-environment attribution, and CSV/JSON export; pane splitting with keyboard-driven focus/swap and broadcast input; desktop notifications with per-session muting; auto-update; SSH host key verification; user-remappable keyboard shortcuts; Claude/Codex hook-driven waiting/idle detection; git worktree support.

## Core Principle

**Dumb pipe, smart shell.** Never parse, intercept, or re-render CLI output. The PTY stream flows byte-for-byte into xterm.js untouched. Status detection is a passive side-channel tap on output cadence, not an interceptor.

## Tech Stack

- **Shell:** Electron 41 (main process owns PTY lifecycle, renderer owns UI)
- **Frontend:** React 19 + TypeScript
- **Terminal:** xterm.js 6.0 + xterm-addon-fit (same as VS Code)
- **Local PTY:** node-pty
- **SSH:** ssh2 (Node.js)
- **Coder:** Coder REST API + SSH-style PTY exec into workspaces
- **Secrets:** HashiCorp Vault integration (KV v2) for env var refs
- **State:** JSON file persistence (`{userData}/data.json`) — SQLite planned but deferred due to native module ABI issues
- **IPC:** Electron IPC (commands + event channels for PTY data streaming)
- **Themes:** Catppuccin (Mocha, Macchiato, Frappé, Latte) + Brass + Tether (Default Dark) + Tether Light
- **CLI tools registry:** Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Custom — selected per session via `src/shared/cli-tools.ts`

## Architecture

- **Main process:** Session Manager, Transport Adapters (Local/SSH/Coder), Session Registry (JSON), Status Detector, CLI Hook Bridge (Claude/Codex overlays), Notification Service, Vault client, Usage/Quota services, Update checker, Git providers (GitHub/ADO/Gitea), Claude/Codex/Copilot/OpenCode transcript readers, Helm MCP bridge, J.O.B.S. office integration (probe/launch + webhook bridge), Diagnostics export
- **Renderer process:** React UI — Sidebar (sessions grouped by working dir, env, vault pill, quota/usage footers), Terminal Pane(s) with split layouts, dialogs (Settings, NewSession, NewEnvironment, About, ResumeChat, KeyboardShortcuts, HostKeyVerify, VaultPicker, etc.), Setup Wizard for first run
- **Transport interface:** All adapters implement `SessionTransport` — the UI is environment-agnostic
- **Data flow:** Keystroke → xterm.js → IPC → transport.write() → PTY stdin → CLI → PTY stdout → status detector (copy) + IPC → xterm.js → screen

## Key Documentation

| File | Contents |
|---|---|
| `README.md` | Project intro, problem/solution, core principles |
| `CHANGELOG.md` | Release history with features and known issues per version |
| `ROADMAP.md` | Pre-1.0 polish plan and post-1.0 plans |
| `docs/ARCHITECTURE.md` | System diagram, component design, data schema, IPC design, key decisions |
| `docs/TRANSPORT_DESIGN.md` | Transport interface (TypeScript), Local/SSH/Coder adapter specs, data flow |
| `docs/1.0_RELEASE_CHECKLIST.md` | Release-mechanics gates (audit, signing, fuses, smoke) for tagging 1.0 |
| `src/docs/*.md` | In-app help docs (rendered in the docs window) |
| `docs/archive/` | Historical originals — `PRODUCT_SPEC.md`, `MVP_SCOPE.md`, `UI_DESIGN.md`. Frozen reference, not maintained. |

## Development Guidelines

### When implementing

- Follow the architecture in `docs/ARCHITECTURE.md` — main process owns PTYs, renderer owns UI
- Use the `SessionTransport` interface from `src/main/transport/types.ts` as the contract for all adapters
- Dark theme by default. Status colors: green (#22C55E), amber (#EAB308), gray (#6B7280), red (#EF4444)
- Per-CLI behavior (resume args, history provider, common flags) goes in `src/shared/cli-tools.ts`, not scattered through transports
- **When adding or changing a feature, update the in-app docs** (`src/docs/*.md`) in the same PR. Check `settings.md`, `sessions.md`, `getting-started.md`, and `keyboard-shortcuts.md` for any sections that reference the feature. User-facing docs ship inside the app — stale docs are bugs.

### Session grouping

Sessions are grouped by working directory in the sidebar. Multiple sessions can exist in the same repo on the same machine. Groups are collapsible. This is a core feature, not a post-MVP nice-to-have.

### Multi-environment support

The user runs CLI sessions across:
1. **Local PC** (Windows) — local PTY via node-pty
2. **Linux VM** (via SSH) — ssh2 with TOFU/known-hosts host key verification, optional sudo elevation
3. **Coder workspaces** — connect to existing workspaces or create new ones from templates via the Coder API

Each environment has preconfigured settings (host, auth, default directory, env vars). Creating a new session in a known environment should be fast — pick environment, optionally override directory/label/CLI tool, go.

### Multi-CLI support

Tether is a dumb-pipe PTY multiplexer; it does not depend on any one CLI. Tools are registered in `src/shared/cli-tools.ts`:
- **Claude Code** — full support including session resume (`--resume`, `--session-id`) and transcript browsing
- **Codex CLI** — full support including session resume (`codex resume <id>`) and transcript browsing
- **OpenCode** — raw PTY only, no resume integration
- **Custom** — any binary the user specifies

CLI flag presets are stored as strings in arrays. Multi-token flags (e.g. `--permission-mode plan`) are tokenized at the transport boundary, so single-string entries with whitespace are split into separate process args.

### Vault integration

Env vars can hold a `vault://` reference instead of a literal value. `vault-resolver.ts` resolves these at session start using `vault-client.ts` (KV v2). Auth modes: token, OIDC. The sidebar shows a Vault status pill; expiry warnings surface before sessions launch.

### Cross-platform hygiene

Tether ships Windows-only today; macOS and Linux are post-1.0 (see `ROADMAP.md`). Bake in the habits now so that port isn't a rewrite.

- **Paths:** compose with `path.join` / `path.resolve` — no hardcoded absolute paths in string literals (no `'C:\\Users\\...'`, no `'/home/...'`). Code that handles both `/` and `\\` separators defensively is fine — that's the goal.
- **Standard dirs:** use `os.homedir()` (not `process.env.HOME` — undefined on Windows — or `process.env.USERPROFILE` — undefined elsewhere). Prefer Electron's `app.getPath('userData' | 'temp' | 'logs')` for app-managed locations.
- **Path comparison:** Windows is case-insensitive, POSIX is case-sensitive. Don't `===` raw paths when behavior depends on equality — normalize via `path.normalize` and decide consciously.
- **Shells:** invoke binaries directly with `child_process.spawn(cmd, args)`. `cmd.exe` / `powershell.exe` only behind a `process.platform === 'win32'` gate (see `local-transport.ts` and `coder-transport.ts` for the pattern). No `shell: true` for one-liners that depend on Windows shell semantics.
- **Windows-only APIs:** registry (`winreg`, `HKLM`, `HKCU`), WMI (`wmic`), Win32 named pipes — only behind a platform gate AND with a documented POSIX equivalent (see the SSH agent fallback in `ssh-transport.ts`).

### What NOT to do

- Never parse or filter ANSI output — raw bytes only
- Never abstract away the native CLI terminal experience
- Don't build task management, agent orchestration, or custom rendering
- Don't store SSH private keys or Vault tokens in plaintext config — reference paths/use the resolver
- Background sessions' terminals stay live off-DOM (PTY data keeps flowing so scrollback survives re-attach), but only active panes are attached to the DOM — don't add rendering or per-frame work for hidden sessions

## Agent Routing

`.claude/agents/` (local, untracked) defines three model-tiered subagents. Route by task shape, not habit:

- `architect` (Opus, effort high) — bounded deep problems: root-causing a specific behavior, design analysis with non-obvious tradeoffs. Returns analysis with file:line evidence; does not usually write production code.
- `coder` (Sonnet, effort low) — implementation with a clear spec, known files, and a defined done-state. Ambiguous specs bounce back rather than get improvised. Bump to effort medium only if specs get looser.
- `scout` (Haiku, read-only) — fast lookups, log/transcript digging, quick verifications. Never edits files.

Standing rules:

1. **Discovery-shaped or cross-cutting work stays at the orchestrator level.** Problems nobody has framed yet — status-detection matrix bugs (transport × CLI × hooks), transport lifecycle races, anything spanning main/renderer/IPC — can't be specced for delegation; they're found by top-level whole-system review. When deep work also needs the current conversation's context, prefer a fork of the main session over `architect` — subagents start blank.
2. Escalate up-tier when a problem resists a bounded framing; never down-tier to save cost on something that keeps bouncing.
3. For ambiguous multi-step work, prefer a full spawned session (which can pause and ask) over a fire-and-forget subagent.

Implementation work still goes through isolated worktrees when parallel sessions are active; at most, fan out independent well-specced cleanups to parallel `coder` runs.

## Build & Run

```bash
npm install          # Install dependencies
npm run start        # Launch in dev mode (Electron Forge + Vite)
npx electron .       # Direct launch (no Vite dev server for renderer)
npx tsc --noEmit     # Type check (preferred over full builds during dev)
npm test             # Vitest unit tests
```

**Note:** Native modules (node-pty) have ABI issues with VS 2025 + Electron 41. Workarounds: lazy node-pty import, JSON persistence instead of SQLite. `better-sqlite3` is in package.json but unused — JSON file storage is the current persistence layer.

## File Structure

```
src/
  main/
    index.ts                          # Electron main entry
    logger.ts                         # File + console logger
    process-guards.ts                 # Global unhandledRejection/uncaughtException guards
    ipc/
      handlers.ts                     # IPC handler registry (wires per-domain modules)
      helpers.ts                      # Shared handler utilities
      *-handlers.ts                   # Per-domain modules: session, env, config, profile, vault,
                                      #   usage, git, ssh, coder, keybindings, notifications, dialog, system
    session/
      session-manager.ts              # Session lifecycle + transport factory
      detect-new-session.ts           # New-session id detection for transcript attribution
    transport/
      types.ts                        # SessionTransport interface
      local-transport.ts              # Local PTY via node-pty
      ssh-transport.ts                # SSH via ssh2 (with TOFU/known-hosts)
      coder-transport.ts              # Coder workspace PTY
      pty-loader.ts                   # Lazy node-pty import (ABI safety)
      ssh2-loader.ts                  # Lazy ssh2 import
      cli-args.ts                     # CLI flag tokenization at the transport boundary
      posix-shell.ts                  # POSIX shell quoting helpers
    status/status-detector.ts         # Passive PTY status detection
    cli-config/
      claude-settings-overlay.ts      # Additive ~/.claude/settings.json hook entry
      codex-config-overlay.ts         # Additive ~/.codex/config.toml notify entry
      overlay-common.ts               # Shared overlay read/write helpers
      hook-bridge.ts                  # Token-authed local socket for hook events
      hook-service.ts                 # Hook overlay lifecycle manager
    notifications/
      notification-service.ts         # Desktop notification dispatch + preferences
    helm/
      bridge.ts                       # MCP spawn_session tool for helm sessions
      integration.ts                  # MCP server lifecycle per helm-enabled session
    diagnostics/
      diagnostics-service.ts          # Scrubbed diagnostic bundle export
      scrub.ts                        # Sensitive-value redaction
    db/
      database.ts                     # JSON file persistence
      atomic-write.ts                 # tmp → fsync → rename atomic writes
      secret-storage.ts               # Electron safeStorage-backed secret encryption
      environment-repo.ts             # Environment CRUD
      session-repo.ts                 # Session CRUD
      profile-repo.ts                 # Launch profile CRUD
      git-provider-repo.ts            # Git provider creds CRUD
      known-hosts-repo.ts             # SSH known_hosts persistence
    ssh/
      host-verifier.ts                # Host key verification policy
      fingerprint.ts                  # SSH key fingerprint formatting
    claude/transcripts.ts             # Claude Code transcript reader
    codex/
      transcripts.ts                  # Codex transcript reader
      session-watcher.ts              # Codex session id capture at spawn
    copilot/
      transcripts.ts                  # Copilot CLI transcript reader
      session-watcher.ts              # Copilot session id capture at spawn
    opencode/
      transcripts.ts                  # OpenCode transcript reader
      session-watcher.ts              # OpenCode session id capture at spawn
      usage-reader.ts                 # OpenCode cost from its local DB
    coder/workspace-service.ts        # Coder workspace list/create via REST API
    vault/
      vault-client.ts                 # HashiCorp Vault REST client
      vault-auth.ts                   # Token + OIDC auth flows
      vault-resolver.ts               # Resolve vault:// refs at session start
      vault-types.ts                  # Vault types
    usage/
      usage-service.ts                # Aggregate per-session and global usage
      jsonl-parser.ts                 # Parse Claude JSONL transcripts
      codex-jsonl-parser.ts           # Parse Codex JSONL transcripts
      cli-tool-aggregator.ts          # Per-CLI-tool usage attribution
      env-aggregator.ts               # Per-environment usage attribution
      usage-exporter.ts               # CSV/JSON usage export
      model-pricing.ts                # Per-model token pricing
      pricing-fetcher.ts              # Daily LiteLLM pricing JSON refresh
    quota/quota-service.ts            # Subscription quota tracking
    jobs/
      jobs-service.ts                 # J.O.B.S. office probe + optional launcher
      jobs-bridge.ts                  # Narrate SSH/Coder sessions to JOBS webhooks
    update/update-checker.ts          # GitHub Releases poll for app updates
    git/
      git-service.ts                  # Local repo + clone helpers
      git-url.ts                      # Git URL parsing/normalization
      providers/
        github-client.ts              # GitHub repo browse/create
        ado-client.ts                 # Azure DevOps repo browse
        gitea-client.ts               # Gitea repo browse
        http.ts                       # Shared provider HTTP helper
  preload/
    preload.ts                        # contextBridge IPC API for main window
    docs-preload.ts                   # contextBridge for docs window
  renderer/
    index.tsx                         # React entry point
    App.tsx                           # Root React component
    components/
      AboutDialog.tsx
      CliToolBadge.tsx
      ConfirmDialog.tsx               # Tether-styled confirm replacement
      DropZoneOverlay.tsx
      EnvVarEditor.tsx
      HelpAnchor.tsx                  # (?) deep-link icon for docs sections
      HostKeyVerifyDialog.tsx         # SSH first-connect host key approval
      KeybindingsEditor.tsx           # Keybinding recorder/editor component
      KeyboardShortcutsDialog.tsx
      MenuBar.tsx
      MigrateToVaultDialog.tsx
      Notifications.tsx
      PaneStatusStrip.tsx             # Per-session cost/token strip
      SettingsDialog.tsx              # App-wide settings (theme, env vars, CLI flags, vault)
      SetupWizard.tsx                 # First-run wizard
      SplitDivider.tsx                # Split pane drag handle
      SplitLayout.tsx                 # Split pane container with snap zones
      TerminalPane.tsx                # xterm.js container + resize
      UsageHistoryDialog.tsx          # Usage history with daily/weekly/monthly rollups
      WelcomePane.tsx                 # Welcome/onboarding pane
      VaultLoginPromptDialog.tsx
      VaultPickerDialog.tsx           # Browse Vault KV paths to pick a secret
      sidebar/
        GlobalUsageFooter.tsx         # Today's cost + 7-day sparkline
        NewEnvironmentDialog.tsx      # Local/SSH/Coder config
        NewSessionDialog.tsx          # Session creation
        PaneLocationBadge.tsx         # Split pane location indicator
        QuotaFooter.tsx               # Subscription quota status
        RepoGroup.tsx                 # Groups sessions by working directory
        ResumeChatDialog.tsx          # Pick a Claude/Codex transcript to resume
        SessionItem.tsx               # Session row with context menu + inline rename
        SidebarResizeHandle.tsx
        VaultStatusPill.tsx           # Vault auth/expiry indicator
    hooks/
      useEscapeKey.ts
      useFocusTrap.ts                 # Dialog focus trap (a11y)
      useKeyboardShortcuts.ts
      useLayoutState.ts               # Pane split layout persistence
      useQuota.ts
      useSessionUsage.ts
      useTerminalManager.ts
      useTheme.ts
      useUsage.ts
    lib/
      broadcast-targets.ts            # Broadcast input target tracking
      layout-tree.ts                  # Split pane layout tree operations
    utils/                            # a11y, errors, paths, duplicate-label,
                                      #   usage-format, usage-rollups, vault-path
    styles/
      global.css                      # Component styles + CSS variable theming
      tokens.css                      # Design tokens (fonts, spacing)
      themes.ts                       # 7 theme definitions
    assets/logo.png
  shared/
    cli-tools.ts                      # CLI tool registry (Claude/Codex/Copilot/OpenCode/Custom)
    constants.ts                      # IPC channel name constants
    keybindings.ts                    # Keybinding actions, chords, defaults
    layout-types.ts                   # Pane split layout types
    loader-themes.ts                  # Splash loader themes
    shell-quote.ts                    # Shell quoting/sanitizing helpers
    types.ts                          # Shared TS interfaces
  docs/                               # In-app help (rendered in docs window)
    getting-started.md
    sessions.md
    environments.md
    settings.md
    keyboard-shortcuts.md
    vault.md
    git-providers.md
    usage-quota.md
    helm.md
  docs-renderer/                      # Docs window renderer entry + styles
```

**Important:** The preload entry is `src/preload/preload.ts` (not `index.ts`) to avoid Vite output collision with main process `index.js` in `.vite/build/`.
