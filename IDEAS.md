# Ideas & Future Work — Tether

A running list of ideas, improvements, and features to explore. Not everything here will get built — this is a brainstorm space.

---

## Near-Term (Next Sessions)

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
