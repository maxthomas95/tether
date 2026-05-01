# Changelog — Tether

All notable changes to this project will be documented in this file.

---

## [0.4.1-beta.2] — 2026-05-01

Patch on top of `0.4.0-beta.1` rolling up new CLI tool support, broader resume-picker coverage, and a security fix for SSH session output.

### New Features
- **GitHub Copilot CLI** added to the CLI tools registry as a supported tool (#39)
- **Resume picker for OpenCode and GitHub Copilot CLI** — both tools now appear in the resume chat dialog with transcript browsing, mirroring the existing Claude/Codex experience (#46)

### Bug Fixes
- **Status indicator stuck on green/grey** — passive status detection no longer latches in stale states (#45)
- **Vault login dialog stuck on "Opening browser…"** — re-opening the dialog now resets state correctly (#44)
- **Helm MCP Coder workspace flow hardened** against edge cases when spawning workspace-backed children (#38)

### Security
- **SSH env values and launch command no longer leak into session output** — secrets passed via env vars are masked from the visible PTY stream on connect (#40)

### Improvements
- README refreshed and a new ROADMAP doc added (#42)

### Dependencies
- `postcss` → 8.5.12 (#43)
- `marked` → 18.0.2 (#41)

---

## [0.4.0-beta.1] — 2026-04-23

Minor bump marking Helm — an opt-in capability that lets a designated Claude session dispatch pre-briefed child sessions through an MCP server — alongside Tether-managed worktrees, deeper Vault UX, and a round of reliability/security fixes.

### New Features
- **Helm (v0 + v0.5)** — opt-in MCP server that lets a designated "helm" session dispatch child sessions. Two-level gate (global "Allow Helm" setting + per-session "Enable Helm" checkbox). Dispatched children surface in the sidebar with a 🪝 badge and skill-labeled names (e.g. "ADO PBI-1234"). MCP tools: `spawn_session`, `create_coder_workspace`, `list_coder_workspaces`, `get_session_status`, `kill_session`. Now supported in packaged builds via bundled MCP subpackage; requires `node` on PATH (#33, #34)
- **Tether-managed worktrees** — create a worktree at session start, with optional cleanup on session removal (#32)
- **Vault browse picker** — pick existing Vault secrets from a tree view instead of typing `vault://` refs by hand (#26)
- **Sidebar Vault pill + pre-session preflight** — auth state, expiry warnings, and preflight that surfaces failures before a session launches (#24)
- **Historical usage scan** — scan all of `~/.claude/projects/` to surface past session usage, not just sessions started inside Tether (#30)

### Bug Fixes
- Cost tracker no longer silently drops sessions whose first prompt is delayed (#29)
- Stale session tabs on restart — workspace is now saved synchronously (#28)
- Workspace persists on every change, so installs don't restore stale tabs (#22)
- Patched `cross-zip` for Node 22+ compatibility (#21)

### Security
- Fixed CodeQL regex-injection and shell-injection alerts (#20)
- PATH hardening on the forge `prePackage` hook — npm is now invoked via `process.execPath` instead of going through `$PATH`
- Cleared SonarCloud findings on VaultPickerDialog and across the Helm v0.5 changes (#23, #27)

### Improvements
- Docs and CLI flag presets refreshed to current state (#31)
- Clarified experimental settings copy in README and settings (#25)

### Dependencies
- `uuid` → 14.0.0 (#35)
- `@xmldom/xmldom` → 0.8.13 (#36)

---

## [0.3.1-hotfix.1] — 2026-04-14

Hotfix bundling three user-facing fixes on top of `0.3.0-beta.1`.

### Bug Fixes
- **SSH TUI corruption from split UTF-8 glyphs** — multi-byte characters straddling network-read boundaries no longer render as replacement glyphs in xterm.js (#15)
- **Codex session resume accuracy** — session id is now captured at spawn so resume picks up the correct conversation (#16)
- **Native `confirm()` replaced with Tether-styled `ConfirmDialog`** — modal dialogs now match the app theme and respect Escape-to-cancel (#17)

---

## [0.3.0-beta.1] — 2026-04-14

Minor bump to mark a process milestone — this is the first release cut through proper PR review with Sonar Quality Gate, CodeQL, and CI all gating the release commit.

### New Features
- **SSH host key verification (TOFU + Known Hosts management)** — first-connect host keys are pinned and verified on subsequent connects; known hosts are manageable from settings
- **Global usage footer** — today's cost and 7-day sparkline in the sidebar footer
- **Per-session cost strip** — cost/token usage shown below each terminal pane (Layer 2)
- **Edit and delete environments** from the sidebar context menu
- **Hide terminal cursor** setting for a distraction-free view
- **Esc-to-close on dialog overlays** — all dialogs now dismiss on Escape

### Security
- **Electron security hardening** — CSP headers, locked-down `window.open`, URL validation on navigation
- **Release flow runs through PR review + quality gates** — release commits can no longer bypass Sonar, CodeQL, or CI

### Bug Fixes
- Fixed duplicate terminal cursor caused by native caret bleeding through the xterm.js textarea
- Fixed Codex quota reset timestamp calculation
- Fixed blank docs window in packaged builds
- Fixed scrollback being dropped when switching between sessions
- Fixed SSH session scrollback lost when switching tabs

### Improvements
- Polished SSH known hosts settings row
- Local CLI binaries are spawned directly instead of via `sh -c`
- Form-bearing dialogs no longer close on outside click (only on Escape or explicit cancel)
- Simplified Vault UX for env vars — one-click store instead of raw `vault://` entry
- Widened About dialog so the tagline fits on one line

### Internal
- Added CI workflow running tests and `npm audit` on every push/PR
- Added SonarCloud badges and Automatic Analysis integration
- Added CodeQL scanning via GitHub's default setup
- Rewrote release script for PR-based flow; dropped all Gitea code paths
- Added `--minor` flag to the release script for milestone version bumps

---

## [0.2.3-beta.4] — 2026-04-13

### New Features
- **Coder workspace creation from templates** — create new Coder workspaces directly from Tether with template selection, parameter forms, live progress, and self-signed cert support
- **SSH sudo elevation** — environments can now be configured to elevate via sudo on connect

### Bug Fixes
- Fixed Coder template listing failing due to nested Template key in API response
- Fixed Coder workspace creation on Windows (path and shell handling)
- Made Coder clone idempotent so workspace restarts don't fail
- Improved Vault OIDC auth_url error messages with full response details

### Improvements
- Vault integration now available in launch profiles and new session dialog
- Vite dev server cold starts significantly faster via pre-declared optimizeDeps

---

## [0.2.2-beta.3] — 2026-04-13

### New Features
- **First-class Codex support** — Codex is now a full peer alongside Claude Code with proper quota tracking and CLI badges
- **Constrained pane layouts with snap previews** — pane tiling now uses defined layout zones with visual snap indicators
- **Usage/cost tracking data layer** — foundational layer for per-session cost and token usage tracking
- **Pinnable and draggable repo groups** — pin favorite groups to the top of the sidebar and reorder by drag-and-drop
- **Subscription quota display** — sidebar footer shows remaining quota percentage for Claude and Codex
- **Update check notifications** — Tether checks GitHub releases on launch and notifies when a new version is available
- **CLI badges in session panel** — active CLI tool shown as a badge on each session for quick identification

### Bug Fixes
- Fixed quota display showing wrong remaining percentage and hiding errors
- Fixed CLI flags leaking across tools when switching between Claude/Codex/OpenCode
- Fixed ghost cursor caused by native caret bleeding through the xterm.js textarea
- Fixed Codex labels in quota display

### Improvements
- Per-session CLI flag overrides — override default flags on individual sessions without affecting others
- Repo group header always visible in sidebar, even for groups with a single session
- Codex quota support in settings with toggle for usage display visibility

---

## [0.2.1-beta.2] — 2026-04-12

### New Features
- **Multi-CLI tool support** — run Codex, OpenCode, or custom CLI tools alongside Claude Code, selectable per session
- **First-launch setup wizard** — guided onboarding for repos root, git provider, and Vault configuration
- **Per-session CLI tool selection** — CLI tool choice moved from environment to session level for finer control

### Bug Fixes
- Fixed duplicate session not preserving the selected CLI tool
- Fixed cursor desync by matching initial PTY size to xterm.js defaults
- Fixed `curlUpload` shell quoting on Windows for release asset uploads

### Improvements
- Dev server can now run alongside the packaged exe without port conflicts
- About dialog version derived from package.json at build time
- Portable zip now uploaded to GitHub releases alongside the installer

---

## [0.2.0-beta.1] — 2026-04-12

Tether's first beta release. All core features — local, SSH, and Coder sessions, split-pane tiling, Vault integration, and session auto-naming — are implemented and working together.

### New Features
- **Coder environment type** — connect to Coder workspaces with a workspace picker and PTY transport, including cloning repos directly into workspaces
- **Split-pane tiling** — tile multiple terminals side-by-side with drag-and-drop rearranging and closest-edge drop zones
- **Pane splitting toggle** — enable or disable pane splitting from the Settings dialog
- **In-app documentation viewer** — browse project docs in a themed BrowserWindow
- **Launch profiles** — quick auth mode switching for different environments
- **Plan detector** — auto-rename sessions based on Claude's plan names

### Improvements
- **Vault coverage expanded** — "Store in Vault" now available for SSH passwords, git provider tokens, and environment variables
- **Vault TLS reliability** — Vault requests use Electron `net.fetch` to avoid TLS failures on corporate networks
- **Pane stability** — fixed self-drop zones and preserved terminal scrollback when moving panes between splits

### Internal
- **GitHub release publishing** — automated asset uploads via `scripts/release.mjs`

---

## [0.1.4-alpha.5] — 2026-04-09

### New Features
- **HashiCorp Vault integration** — store SSH passwords, git provider tokens, and sensitive env vars in Vault. OIDC login, secret migration wizard, and `vault://` references throughout the app.
- **Test suite** — 42 unit tests covering StatusDetector, environment-repo, and session-repo using Vitest. Includes database mock for isolated testing without Electron.
- **Structured logging** — new logger module writes to `{userData}/logs/tether.log` with log levels (error/warn/info/debug), file rotation at 5 MB, and scoped category tags.
- **Resume-chat picker** — pick a previous Claude transcript to resume when creating a session, with session continuity via `--resume`.
- **Themed boot loader** — inline loading screen matches the active theme, eliminating the blank white flash on launch.
- **Welcome page logo** — app logo displayed on the welcome screen when no sessions are open.
- **Release automation** — `scripts/release.mjs` handles version bump, changelog, tagging, building, and Gitea publishing in 8 idempotent phases.

### Improvements
- Vault settings shown inline in the Settings dialog instead of behind a disclosure.
- Logging wired into app lifecycle, session manager, local/SSH transports, IPC handlers, Vault login, and git operations for production diagnostics.
- Error toasts surface IPC errors in the UI instead of only in the DevTools console.

### Bug Fixes
- Fixed Squirrel installer launching multiple app windows on install/update/uninstall events.
- Fixed duplicate `useEffect` in App.tsx that loaded resume badge/picker settings twice on every Settings dialog close.
- Fixed SSH session crash caused by temporal dead zone when SSH transports emit data events before `transport.start()` resolves.

---

## [0.1.3-alpha.4] — 2026-04-07

### New Features
- **Git provider integrations** — Gitea and Azure DevOps support in the New Session dialog. Browse and search remote repos, then clone or init directly into your repos root.
- **SSH password authentication** — SSH environments can now authenticate with a password in addition to private key auth.
- **Functional menu bar** — File, Session, View, and Help menus are now wired up with real actions (previously placeholders).

### Bug Fixes
- Fixed kill-session bug where killed sessions could leave dangling state; added single-instance lock so only one Tether window runs at a time.
- Gitea repo listing now correctly handles the `SearchResults` API wrapper and surfaces API errors instead of failing silently.
- DevTools no longer auto-open when the app launches.

### Internal
- Documentation pass to bring all spec/architecture docs in line with the current implementation.

---

## [0.1.2-alpha.3] — 2026-04-05

### New Features
- **Catppuccin themes** — full theming system with all four Catppuccin flavors (Mocha, Macchiato, Frappé, Latte) plus the original Default Dark. Themes persist across sessions and include terminal ANSI palette colors.
- **Custom titlebar** — hidden native frame replaced with themed overlay for min/max/close buttons
- **VS Code-style menubar** — branded top bar with File/Help placeholders and Tether logo

### Improvements
- App icon set on window and Squirrel installer
- Logo displayed in menubar alongside title
- Asset type declarations for PNG/JPG/SVG imports

---

## [0.1.0-alpha.2] — 2026-04-04

### New Features
- **Workspace save/restore** — sessions auto-save on quit and restore on next launch. Toggle in Settings.
- **CLI flags** — configure flags like `--dangerously-skip-permissions` in Settings (app-wide) or per-session in the New Session dialog. Custom flags supported.
- **Clipboard support** — Ctrl+C (with selection) copies, Ctrl+V pastes, Ctrl+Shift+C always copies
- **Shift+Enter multi-line input** — works like VS Code's terminal for multi-line prompts

### Improvements
- Settings dialog now has "Restore sessions on launch" toggle
- New Session dialog shows inherited CLI flags from defaults
- Dialog body scrollable when content overflows

---

## [0.1.0-alpha.1] — 2026-04-04

The first working build. Tether runs as a standalone Windows exe.

### Core
- Electron + React + TypeScript app with xterm.js terminal
- Multiple concurrent Claude Code sessions with instant switching
- Session sidebar with environment groups and auto-grouping by repo
- Passive status detection — green (running), amber (waiting), gray (idle), red (dead)
- JSON file persistence — environments and sessions survive app restarts

### Session Management
- Create sessions via directory picker or repos root quick-pick
- Right-click context menu: Rename, Duplicate, Stop, Kill, Remove
- Keyboard shortcuts: Ctrl+N (new), Ctrl+1-9 (switch), Ctrl+Up/Down (navigate), Ctrl+B (toggle sidebar), Ctrl+W (stop)
- Resizable sidebar with drag handle

### Environment Variables
- 3-level cascade: App defaults -> Environment -> Session override
- Reusable EnvVarEditor with Quick Add presets for common Claude Code vars
- Sensitive value masking (API keys, tokens)
- Settings dialog for app-level defaults

### Multi-Environment
- Local sessions via node-pty (ConPTY on Windows)
- SSH transport adapter (ssh2) with preconfigured host/port/user/key presets
- New Environment dialog for SSH configuration

### Known Issues
- VS 2025 not recognized by node-gyp — using prebuilt N-API binaries and JSON persistence instead of SQLite
- Status detection heuristics may need tuning across different Claude Code versions
- No error toasts yet — errors show in DevTools console only
