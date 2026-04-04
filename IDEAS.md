# Ideas & Future Work — Tether

A running list of ideas, improvements, and features to explore. Not everything here will get built — this is a brainstorm space.

## Design Philosophy

Tether is a **HUD around Claude Code**, not a replacement. Claude Code is great at what it does — Tether makes it easier to use at scale. If Claude Code already does something well, don't replicate it. Focus on:
- **Organizing** sessions (tabs, groups, sidebar)
- **Configuring** environments (env vars, MCPs, settings injection)
- **Managing** multi-environment workflows (local, SSH, Coder from one place)
- **Persisting** state (save/restore workspaces)

---

## Near-Term (Next Sessions)

### Env Var Injection (Ready to Build)

Before launching `claude`, Tether sends environment variable commands to the PTY. This is how we configure API keys, model preferences, effort flags, etc. — all defined in Tether's UI and applied automatically.

**How it works:**
- Detect the target OS (Windows → `set VAR=value`, Linux → `export VAR=value`)
- Send env commands to the PTY *before* running `claude`
- Configurable at environment level (applies to all sessions in that env) or per-session override

**Example env vars to manage:**
- `ANTHROPIC_API_KEY` — API key injection
- `ANTHROPIC_MODEL` — default model (opus, sonnet, haiku)
- `ANTHROPIC_SMALL_FAST_MODEL` — fast model for background tasks
- `CLAUDE_CODE_MAX_TOKENS` / effort flags
- `ANTHROPIC_BASE_URL` — OpenRouter or custom endpoint
- Custom vars: `DATABASE_URL`, `NODE_ENV`, whatever the project needs

**UX:** Settings panel or per-environment config with a key-value editor. Simple table: Name | Value | Scope (all sessions / this env only).

Already partially implemented — the transport layer accepts `env` in start options. Need: UI for managing env vars, cascade logic (app → env → session), and the OS detection for remote sessions.

### Workspace Save/Restore

Save the current session layout and restore it later — like browser session restore.

**What gets saved:**
- Which sessions are open (directory, environment, label)
- Their positions/order in the sidebar
- Which session was active
- Optionally: the Claude Code `--resume` session ID for conversation continuity

**UX ideas:**
- **Auto-save on quit** — "Restore previous sessions?" on next launch
- **Named workspaces** — save as "Frontend sprint" / "Incident response" / "Friday cleanup", switch between them
- **Quick-switch** — dropdown or Ctrl+Shift+W to swap workspace sets
- Sessions restore as "stopped" initially, then you can click to relaunch (or "Restore All" button)

**Implementation:** Workspace = JSON blob of session configs. Store in data.json under `workspaces[]`. On restore, create sessions from the saved configs.

### Session Config Injection (Bigger Picture)

When you create a session, Tether could automatically configure Claude Code's settings, MCP servers, permissions, hooks, etc. — so every session gets the right setup without manual work across machines.

**What Tether could manage:**
- **MCP servers** — define MCPs in Tether, auto-write `.mcp.json` or inject into `claude_desktop_config.json` before session launch. Different MCP sets per environment (e.g., Slack MCP only on local, DB MCP only on prod VMs)
- **Claude settings** — auto-generate/merge `settings.json` per environment (model preferences, permission allowlists, theme, etc.)
- **CLAUDE.md injection** — maintain CLAUDE.md templates in Tether, auto-write to the working directory on session start (or append to existing). Environment-specific context like "you are on the staging server" or "this repo uses pnpm"
- **Hooks** — define hooks in Tether that get written to `.claude/settings.json` on session start (e.g., auto-lint on file save, notify on session idle)
- **Permission presets** — preconfigure which tools are auto-allowed per environment (e.g., allow all bash on local, restrict on prod)
- **Environment variables** — already partially done (API keys, model), but extend to arbitrary env vars (e.g., `DATABASE_URL`, `NODE_ENV`)

**Config layers (cascade like CSS):**
```
App defaults → Environment → Session override
```
Each level can set, override, or inherit from above. A session in the "Production VM" environment inherits that env's MCP config, permissions, and CLAUDE.md, but can override the model.

**UX ideas:**
- "Config Profiles" — named bundles of settings (e.g., "Frontend Dev", "Backend Debug", "Prod Incident") that you can attach to any environment or session
- Visual diff before session start — "these settings will be applied" preview
- Import/export profiles to share across machines or teammates

**Implementation approach:**
- Store config templates in Tether's data store (JSON)
- On session create, before spawning the PTY:
  1. Resolve the config cascade (app → env → session overrides)
  2. Write/merge `.mcp.json` to the working directory (or temp location)
  3. Set env vars for Claude Code settings that support them
  4. For things that need files on disk (CLAUDE.md, hooks), write them before launch
- For remote sessions (SSH/Coder): write config files via the SSH connection before launching claude

**Open questions:**
- Should Tether own the config files or merge with existing ones? (Merge is safer but more complex)
- How to handle config cleanup when a session ends? (Leave in place vs. revert)
- Should config profiles be version-controlled (git) or just Tether-internal?

### SSH & Remote Polishing
- **Connection test button** in environment config — validate SSH connectivity before saving
- **SSH key passphrase support** — prompt for passphrase if key is encrypted
- **Reconnect action** — right-click a dead SSH session to reconnect (new PTY, same directory)
- **Connection status indicator** on environment group headers (green = reachable, red = unreachable)

### Coder Integration
- **Connect to existing workspaces** via `coder ssh` / `coder config-ssh` approach
- **Workspace picker** — list available Coder workspaces when creating a session
- **Start stopped workspaces** — if a workspace is off, offer to start it before connecting
- **Coder URL + token config** in environment settings

### Session Experience
- **Session resume** — use Claude Code's `--resume` flag to continue a previous conversation
- **Session restart** — relaunch Claude Code in the same directory after it exits
- **Auto-label from git branch** — detect the current git branch in the working directory and use it as the default label
- **Session search/filter** — type-to-filter in the sidebar when you have 10+ sessions

---

## Medium-Term

### Multi-Model & Auth
- **Per-session model override** — dropdown to pick model (Sonnet, Opus, Haiku) at session creation
- **OpenRouter integration** — inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` for OpenRouter sessions
- **API key management** — encrypted storage via Electron safeStorage (DPAPI on Windows)
- **Quick model switch** — change model mid-conversation by restarting with `--resume` and different `ANTHROPIC_MODEL`

### Sidebar UX Improvements
- **Drag-and-drop reorder** within environment groups
- **Session pinning** — pin frequently-used sessions to the top
- **Last-active sorting** — option to sort sessions by most recently active
- **Collapsible stopped sessions** — group dead/stopped sessions at the bottom
- **Environment badges** showing SSH host, Coder workspace name in compact form
- **Notification dots** — show a badge when a background session transitions to "waiting" (needs your input)

### Terminal Enhancements
- **Split pane** — view two sessions side by side
- **Session tab bar** — optional tab bar above terminal as alternative to sidebar-only navigation
- **Scrollback search** — Ctrl+Shift+F to search terminal output history
- **Session transcript export** — save raw or cleaned terminal output to file

---

## Long-Term / Exploratory

### Desktop Notifications
- **Background session alerts** — desktop notification when a session transitions from "running" to "waiting"
- **Configurable notification rules** — only notify for specific sessions or environments
- **Sound alerts** — optional audio ping

### Agent Orchestration (Layer on Top)
- **Batch prompt** — send the same prompt to multiple sessions simultaneously
- **Session templates** — preconfigured session setups (directory + model + env vars + initial prompt)
- **Workflow automation** — chain of prompts across sessions with dependencies
- **Session monitoring dashboard** — overview of all session states, resource usage, uptime

### Platform & Distribution
- **macOS build** — test and polish on Mac (Cmd key mapping, Keychain for secrets)
- **Linux build** — AppImage or .deb distribution
- **Auto-updates** — Electron auto-updater for seamless updates
- **Portable mode** — run from USB drive with local config

### Integration Ideas
- **VS Code extension** — sidebar panel in VS Code that shows Tether session states
- **CLI companion** — `tether create --dir ~/repos/foo --ssh myvm` to create sessions from terminal
- **Web dashboard** — lightweight web view for checking session states from phone/tablet
- **GitHub integration** — auto-create a session when a PR is assigned to you, pre-configured to the right branch

### Architecture Improvements
- **SQLite persistence** — migrate from JSON when node-gyp/VS 2025 issues are resolved (better query perf at scale)
- **Session log storage** — persist terminal output to disk for search and replay
- **Plugin system** — allow third-party transport adapters (Kubernetes, cloud VMs, etc.)
- **Multi-window support** — detach a session into its own window

---

## Known Issues / Tech Debt

- **VS 2025 + node-gyp**: Native module compilation doesn't work. Using JSON persistence and prebuilt binaries as workaround. Track upstream node-gyp for VS 2025 support.
- **Electron Forge Vite entry naming**: Preload entry must not be named `index.ts` to avoid output collision. Documented in CLAUDE.md.
- **Status detection accuracy**: Prompt heuristics may need tuning with real Claude Code sessions across different models and workflows.
- **No error toasts yet**: Failed session creation shows in DevTools console but not in the UI.

---

*Add ideas freely. Mark items with ~~strikethrough~~ when completed or dropped.*
