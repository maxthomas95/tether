# CLAUDE.md — Tether

## Project Overview

Tether is a desktop session multiplexer for Claude Code and Codex CLI. It provides a single unified interface to manage multiple agentic CLI sessions across local, SSH, and Coder workspace environments — preserving the exact native terminal experience via raw PTY piping into xterm.js.

**Status:** Active development. Currently `0.3.1` (with `0.3.0-beta.1` as the most recent feature release). Local, SSH, and Coder transports working; multi-CLI support (Claude/Codex/OpenCode/Custom); Vault-backed env vars; usage and quota tracking; pane splitting; auto-update; SSH host key verification.

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
- **Themes:** Catppuccin (Mocha, Macchiato, Frappe, Latte) + Default Dark
- **CLI tools registry:** Claude Code, Codex CLI, OpenCode, Custom — selected per session via `src/shared/cli-tools.ts`

## Architecture

- **Main process:** Session Manager, Transport Adapters (Local/SSH/Coder), Session Registry (JSON), Status Detector, Vault client, Usage/Quota services, Update checker, Git providers (ADO/Gitea), Codex/Claude transcript readers
- **Renderer process:** React UI — Sidebar (sessions grouped by working dir, env, vault pill, quota/usage footers), Terminal Pane(s) with split layouts, dialogs (Settings, NewSession, NewEnvironment, About, ResumeChat, KeyboardShortcuts, HostKeyVerify, VaultPicker, etc.), Setup Wizard for first run
- **Transport interface:** All adapters implement `SessionTransport` — the UI is environment-agnostic
- **Data flow:** Keystroke → xterm.js → IPC → transport.write() → PTY stdin → CLI → PTY stdout → status detector (copy) + IPC → xterm.js → screen

## Key Documentation

| File | Contents |
|---|---|
| `README.md` | Project intro, problem/solution, core principles |
| `CHANGELOG.md` | Release history with features and known issues per version |
| `docs/PRODUCT_SPEC.md` | Vision, target user, user stories (SF-01 through SF-34), non-goals |
| `docs/MVP_SCOPE.md` | Original MVP definition, milestones (M1-M5), post-MVP roadmap |
| `docs/ARCHITECTURE.md` | System diagram, component design, data schema, IPC design, key decisions |
| `docs/TRANSPORT_DESIGN.md` | Transport interface (TypeScript), Local/SSH/Coder adapter specs, data flow |
| `docs/UI_DESIGN.md` | Layout mockups, sidebar, terminal panel, dialogs, keyboard shortcuts, visual design |
| `src/docs/*.md` | In-app help docs (rendered in the docs window) |

## Development Guidelines

### When implementing

- Follow the architecture in `docs/ARCHITECTURE.md` — main process owns PTYs, renderer owns UI
- Use the `SessionTransport` interface from `src/main/transport/types.ts` as the contract for all adapters
- Follow UI specs in `docs/UI_DESIGN.md` for layout, colors, keyboard shortcuts
- Dark theme by default. Status colors: green (#22C55E), amber (#EAB308), gray (#6B7280), red (#EF4444)
- Per-CLI behavior (resume args, history provider, common flags) goes in `src/shared/cli-tools.ts`, not scattered through transports

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

### What NOT to do

- Never parse or filter ANSI output — raw bytes only
- Never abstract away the native CLI terminal experience
- Don't build task management, agent orchestration, or custom rendering
- Don't store SSH private keys or Vault tokens in plaintext config — reference paths/use the resolver
- Don't send PTY data for background sessions to the renderer — only the active session(s) stream to the DOM

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
    ipc/handlers.ts                   # IPC handler registry
    session/session-manager.ts        # Session lifecycle + transport factory
    transport/
      types.ts                        # SessionTransport interface
      local-transport.ts              # Local PTY via node-pty
      ssh-transport.ts                # SSH via ssh2 (with TOFU/known-hosts)
      coder-transport.ts              # Coder workspace PTY
    status/status-detector.ts         # Passive PTY status detection
    db/
      database.ts                     # JSON file persistence
      environment-repo.ts             # Environment CRUD
      session-repo.ts                 # Session CRUD
      profile-repo.ts                 # Launch profile CRUD
      git-provider-repo.ts            # Git provider creds CRUD
      known-hosts-repo.ts             # SSH known_hosts persistence
    ssh/host-verifier.ts              # Host key verification policy
    claude/transcripts.ts             # Claude Code transcript reader
    codex/
      transcripts.ts                  # Codex transcript reader
      session-watcher.ts              # Codex session id capture at spawn
    vault/
      vault-client.ts                 # HashiCorp Vault REST client
      vault-auth.ts                   # Token + OIDC auth flows
      vault-resolver.ts               # Resolve vault:// refs at session start
      vault-types.ts                  # Vault types
    usage/
      usage-service.ts                # Aggregate per-session and global usage
      jsonl-parser.ts                 # Parse Claude/Codex JSONL transcripts
      model-pricing.ts                # Per-model token pricing
    quota/quota-service.ts            # Subscription quota tracking
    update/update-checker.ts          # GitHub Releases poll for app updates
    git/
      git-service.ts                  # Local repo + clone helpers
      providers/
        ado-client.ts                 # Azure DevOps repo browse
        gitea-client.ts               # Gitea repo browse
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
      HostKeyVerifyDialog.tsx         # SSH first-connect host key approval
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
      VaultLoginPromptDialog.tsx
      VaultPickerDialog.tsx           # Browse Vault KV paths to pick a secret
      sidebar/
        GlobalUsageFooter.tsx         # Today's cost + 7-day sparkline
        NewEnvironmentDialog.tsx      # Local/SSH/Coder config
        NewSessionDialog.tsx          # Session creation
        QuotaFooter.tsx               # Subscription quota status
        RepoGroup.tsx                 # Groups sessions by working directory
        ResumeChatDialog.tsx          # Pick a Claude/Codex transcript to resume
        SessionItem.tsx               # Session row with context menu + inline rename
        SidebarResizeHandle.tsx
        VaultStatusPill.tsx           # Vault auth/expiry indicator
    hooks/
      useEscapeKey.ts
      useKeyboardShortcuts.ts
      useLayoutState.ts               # Pane split layout persistence
      useQuota.ts
      useSessionUsage.ts
      useTerminalManager.ts
      useTheme.ts
      useUsage.ts
    styles/
      global.css                      # Component styles + CSS variable theming
      themes.ts                       # 5 theme definitions
    assets/logo.png
  shared/
    cli-tools.ts                      # CLI tool registry (Claude/Codex/OpenCode/Custom)
    constants.ts                      # IPC channel name constants
    layout-types.ts                   # Pane split layout types
    loader-themes.ts                  # Splash loader themes
    types.ts                          # Shared TS interfaces
  docs/                               # In-app help (rendered in docs window)
    getting-started.md
    sessions.md
    environments.md
    settings.md
    keyboard-shortcuts.md
```

**Important:** The preload entry is `src/preload/preload.ts` (not `index.ts`) to avoid Vite output collision with main process `index.js` in `.vite/build/`.
