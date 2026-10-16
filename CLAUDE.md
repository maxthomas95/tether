# CLAUDE.md — Tether

## Project Overview

Tether is a desktop session multiplexer for Claude Code, Codex CLI, and OpenCode. It provides a single unified interface to manage multiple agentic CLI sessions across local, SSH, and Coder workspace environments — preserving the exact native terminal experience via raw PTY piping into xterm.js.

**Status:** The `0.7.x` stable line graduates the soaked `0.6.x` beta train; Windows 1.0 polish continues. Local/SSH/Coder sessions, conversation recovery, split/Canvas layouts, workspace recipes, encrypted launch snapshots, local/remote Claude/Codex usage, local native OpenCode/legacy Crush usage, child-agent viewers, CLI maintenance, optional Pip/GIF/J.O.B.S. integrations, and stable/beta update notifications are implemented. See `CHANGELOG.md` for release scope and `ROADMAP.md` for remaining work.

## Core Principle

**Dumb pipe, smart shell.** Never parse, intercept, or re-render CLI output. The PTY stream flows byte-for-byte into xterm.js untouched. Status detection is a passive side-channel tap on output cadence, not an interceptor.

## Tech Stack

- **Shell:** Electron 44 (sandboxed preloads; main owns PTY lifecycle, renderer owns UI)
- **Frontend:** React 19 + TypeScript
- **Terminal:** xterm.js 6.0 + xterm-addon-fit (same as VS Code)
- **Local PTY:** node-pty
- **SSH:** ssh2 (Node.js)
- **Coder:** Coder REST API + SSH-style PTY exec into workspaces
- **Secrets:** HashiCorp Vault integration (KV v2) for env var refs
- **State:** Atomic JSON persistence (`{userData}/data.json`); secrets and saved launch overrides use safeStorage. SQLite app-state migration is deferred; the native OpenCode and legacy Crush usage readers use built-in `node:sqlite` in read-only mode.
- **IPC:** Electron IPC (commands + event channels for PTY data streaming)
- **Themes:** Catppuccin (Mocha, Macchiato, Frappé, Latte) + Brass + Tether (Default Dark) + Tether Light + Nord + Gruvbox (Dark, Light) + Harbor
- **CLI tools registry:** Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Custom — selected per session via `src/shared/cli-tools.ts`

## Architecture

- **Main process:** Session Manager, Transport Adapters (Local/SSH/Coder), Session Registry (JSON), Status Detector, CLI Hook Bridge (Claude/Codex overlays), Notification Service, Vault client, Usage/Quota services, Update checker, Git providers (GitHub/ADO/Gitea), Claude/Codex/Copilot/OpenCode transcript readers, Helm MCP bridge, J.O.B.S. office integration (probe/launch + webhook bridge), Diagnostics export
- **Renderer process:** React UI — grouped sidebar and read-only child viewers, single/split/Canvas terminals, workspace recipes, terminal search, settings/launch dialogs, first-run wizard, optional GIF/Pip panels
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
- Use relative `.md` links between help pages (for example, `settings.md#appearance`) so navigation works both on GitHub and in the docs window.

### Session grouping

Sessions are grouped by working directory in the sidebar. Multiple sessions can exist in the same repo on the same machine. Groups are collapsible. This is a core feature, not a post-MVP nice-to-have.

### Multi-environment support

The user runs CLI sessions across:
1. **Local PC** (Windows) — local PTY via node-pty
2. **Linux VM** (via SSH) — ssh2 with TOFU/known-hosts host key verification, optional sudo elevation
3. **Coder workspaces** — connect to existing workspaces or create new ones from templates via the Coder API

Each environment has preconfigured settings (host, auth, default directory, env vars). Creating a new session in a known environment should be fast — pick environment, optionally override directory/label/CLI tool, go.

### Multi-CLI support

Tether is a dumb-pipe PTY multiplexer; it does not depend on any one CLI.

Claude Code, Codex CLI, and OpenCode are first-class product targets. Review existing and planned features for equivalent outcomes across all three, including the supported local/SSH/Coder paths. Share common behavior, use native adapters for tool-specific interfaces, and document verified capability or version limitations. Native OpenCode usage covers the supported local SQLite schema; remote usage and local/remote quota remain unsupported. Copilot and Custom support must continue to work when common paths change.

Tools are registered in `src/shared/cli-tools.ts`:

- **Claude Code** — full support including session resume (`--resume`, `--session-id`) and transcript browsing
- **Codex CLI** — full support including session resume (`codex resume <id>`) and transcript browsing
- **GitHub Copilot CLI** — local session resume (`copilot --resume <id>`) and transcript browsing; no cost reader
- **OpenCode** — local session resume (`opencode --session <id>`) and transcript browsing; read-only native SQLite step-finish usage accounting plus legacy Crush snapshots
- **Custom** — any binary the user specifies

CLI flag presets are stored as strings in arrays. Multi-token flags (e.g. `--permission-mode plan`) are tokenized at the transport boundary, so single-string entries with whitespace are split into separate process args.

Native OpenCode database discovery uses supported native source layouts and the effective local launch environment (`OPENCODE_DB`, `XDG_DATA_HOME`, home overrides and supported channel database selection). Uncertain channel/source locations leave usage unavailable; discovery does not invoke a database command. Startup backfill uses the application environment; active local sessions poll every 10 seconds.

The reader keeps provider/model, input/output, cache and reasoning breakdowns, and preserves CLI-reported cost including zero. Reported amounts and API-equivalent estimates are distinct sources; neither is a subscription invoice. Failed first reads show unavailable/Unknown, while later failures preserve last-known totals. Imported timestamp fallbacks are approximate; ambiguous fork timestamps, invalid/unsupported schemas and read limits leave usage unavailable.

The OpenCode history picker still uses the default application environment, while local launch-time existence checks and new-session discovery honor launch overrides.

### Vault integration

Env vars can hold a `vault://<mount>/<path>#<key>` reference instead of a literal value. `vault-resolver.ts` resolves these at session start using `vault-client.ts` (KV v2). Login uses browser OIDC; the token is cached encrypted with Electron safeStorage. There is no pasted-token or token-file auth UI. The sidebar shows a Vault status pill and expiry warnings; renewal requires logging in again.

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

Agent routing is governed by [AGENTS.md](AGENTS.md) and the tools available in the current session. Local, untracked agent definitions or a user-installed forwarding plugin are optional development tooling, not dependencies shipped with Tether. Route by task shape when delegation is explicitly requested:

- `architect` — bounded root-cause or design analysis, with file:line evidence; usually no production edits.
- `coder` — implementation with a clear spec, known files, an assigned worktree, and a defined done-state; report ambiguity instead of improvising.
- `scout` — read-only lookups, logs/transcripts, and quick verification.

Use custom subagents only when the user explicitly asks for subagents, parallel agents, delegation, or this routing behavior. Model/effort pins belong to the current agent definitions, not this public architecture guide. Delegated runs follow this repo's instructions too.

Standing rules:

1. **Discovery-shaped or cross-cutting work stays at the orchestrator level.** Problems nobody has framed yet — status-detection matrix bugs (transport × CLI × hooks), transport lifecycle races, anything spanning main/renderer/IPC — can't be specced for delegation; they're found by top-level whole-system review. When deep work also needs the current conversation's context, prefer a fork of the main session over `architect` — subagents start blank.
2. Escalate up-tier when a problem resists a bounded framing; never down-tier to save cost on something that keeps bouncing.
3. For ambiguous multi-step work, prefer a full spawned session (which can pause and ask) over a fire-and-forget subagent.

Implementation work still goes through isolated worktrees when parallel sessions are active; at most, fan out independent well-specced cleanups to parallel `coder` runs.

## Build & Run

```bash
node --version       # CI uses Node 24
npx npm@10.9.4 ci    # Install the locked dependencies with CI's npm version
npm run start        # Launch in dev mode (Electron Forge + Vite)
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run lint         # ESLint
npm test             # Vitest tests
npm run test:packaging # Packaging helper tests
```

Also run `npm run test:security` and the documented dependency gates when relevant. For packaging changes, run `npm run package` and `npm run verify:package`; releases also require `npm run make` and packaged runtime smoke. CI separately builds/audits Helm and audits root/runtime dependencies; see `.github/workflows/ci.yml` and `docs/DEPENDENCY_SECURITY.md`. Settings has nine sections, including CLI tools. See `src/docs/settings.md` for controls and save behavior.

**Native packaging:** Forge uses pinned prebuilt node-pty binaries instead of rebuilding with unsupported Visual Studio toolchains. Windows local/Coder PTYs use bundled ConPTY DLL support so shutdown works with `RunAsNode` disabled. Keep the packaged verifier and real PTY startup/stop smoke green; app state remains JSON.

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
                                      #   usage, git, ssh, coder, keybindings, notifications, dialog, system, subagent
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
    claude/subagents.ts               # Claude subagent files -> child rows (parse + incremental read)
    claude/subagent-tracker.ts        # Per-session subagent refresh: hook events + stat poll, push to renderer
    claude/remote-subagents.ts        # SSH/Coder subagent source: offsets + pure parsers over the resident remote reader
    transcripts/
      json-lines.ts                   # JSONL line helpers shared by the Claude and Codex child-row readers
      incremental-lines.ts            # Offset-based line folding + head/tail viewer reader shared by both
      child-tracker-support.ts        # Single-flight, debounce, change-only broadcast and reader pool for child trackers
    codex/
      transcripts.ts                  # Codex transcript reader
      exec-rollouts.ts                # Codex rollout parse (pure) + incremental reader -> codex exec child rows
      exec-tracker.ts                 # Per-session codex exec children: Codex hook events + rollout reads
      session-watcher.ts              # Codex session id capture at spawn
    copilot/
      transcripts.ts                  # Copilot CLI transcript reader
      session-watcher.ts              # Copilot session id capture at spawn
    opencode/
      transcripts.ts                  # OpenCode transcript reader
      session-watcher.ts              # OpenCode session id capture at spawn
      usage-reader.ts                 # Legacy Crush session snapshots (read-only SQLite)
      native-usage-reader.ts          # Native OpenCode step-finish accounting (read-only SQLite)
      native-usage-source.ts          # Passive native DB path resolution with launch environment
    coder/workspace-service.ts        # Coder CLI workspace list/create + template API lookup
    cli-maintenance/                  # Temporary native version/update terminals
    workspace-recipes/                # Recipe persistence, validation and fresh launches
    pip/                              # Optional bounded AI comments and consented prompt context
    vault/
      vault-client.ts                 # HashiCorp Vault REST client
      vault-auth.ts                   # Browser OIDC + encrypted token cache
      vault-resolver.ts               # Resolve vault:// refs at session start
      vault-types.ts                  # Vault types
    usage/
      usage-service.ts                # Aggregate per-session and global usage
      remote-probe.ts                 # Resident remote reader program (usage + subagent requests)
      remote-probe-channels.ts        # One shared resident reader per SSH host/Coder workspace, with backoff
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
      ChildAgentViewer.tsx            # Read-only subagent transcript dialog
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
      SettingsDialog.tsx              # Nine searchable settings sections
      CanvasLayout.tsx                # Movable/resizable session panels
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
        ChildAgentRows.tsx            # Collapsible subagent rows under a Claude session
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
      themes.ts                       # 11 theme definitions
    assets/logo.png
  shared/
    cli-tools.ts                      # CLI tool registry (Claude/Codex/Copilot/OpenCode/Custom)
    child-agents.ts                   # Generic child-agent model (subagent rows) shared by main/renderer
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
