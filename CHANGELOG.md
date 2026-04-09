# Changelog — Tether

All notable changes to this project will be documented in this file.

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
