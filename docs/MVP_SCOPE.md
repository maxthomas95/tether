# MVP Scope — Tether

> **Note:** This document was the original MVP plan. As of v0.3.x, all MVP milestones (M1-M5) are complete and most post-MVP items have shipped: SSH adapter (with TOFU/known-hosts verification), Coder workspace adapter, environment management, session grouping, workspace persistence, Claude/Codex session resume, multi-CLI support (Claude/Codex/OpenCode/Custom), Vault-backed env vars, usage/cost tracking, pane splitting, and auto-update. Items below are annotated with their current status.

## MVP Definition

The MVP is the smallest build that is **genuinely useful for daily work.** After the MVP, you should be able to close all your terminal tabs and tmux sessions and manage your Claude Code sessions entirely through Tether — at least for local sessions.

## In Scope (MVP)

### Local Sessions Only
- Spawn Claude Code in any local directory via `node-pty`
- Full native terminal experience via xterm.js
- Multiple simultaneous sessions (target: 10+ without performance issues)
- Session stop/kill
- PTY survives renderer process issues (lives in main process)

### Sidebar
- List of all active sessions
- Manual label for each session
- Status dot (green/yellow/gray/red) based on passive output detection
- Click to switch between sessions (instant — xterm instance stays alive in background)
- Visual indicator for which session is currently active
- Right-click context menu: rename, stop, kill

### Session Configuration
- Per-session environment variable injection at spawn time
- OpenRouter support: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` fields
- Simple config panel (not a full environment management UI yet)

### Keyboard Navigation
- `Cmd/Ctrl+N` — new session
- `Cmd/Ctrl+W` — stop current session
- `Cmd/Ctrl+1..9` — jump to session by position
- `Cmd/Ctrl+↑/↓` — previous/next session
- All other keystrokes pass through to Claude Code untouched

### Persistence
- Session list persists across app restarts (JSON file)
- Workspace save/restore — sessions auto-save on quit and restore on next launch (toggle in Settings)
- Running PTYs do NOT persist across app restarts (PTY dies with the Electron process)
- On restart, previously-running sessions show as "stopped" and can be manually restarted

### Status Detection
- Passive byte-stream tap (no ANSI parsing)
- Green (active output), yellow (waiting), gray (idle), red (dead)
- Debounced transitions to prevent flicker

## Out of Scope (MVP)

### ~~SSH Adapter~~ — DONE (alpha.1)
Implemented in `ssh-transport.ts`. Supports host/port/username, private key or SSH agent auth, keepalive, env var injection.

### ~~Container/Coder Adapter~~ — DONE (0.2.x)
Full Coder workspace integration in `coder-transport.ts` — connect to existing workspaces or create new ones from templates with parameter forms, live progress, and self-signed cert support.

### ~~Environment Management UI~~ — DONE (alpha.1)
Full environment registry with `NewEnvironmentDialog.tsx`. Supports Local and SSH types with per-environment env vars.

### ~~Session Grouping in Sidebar~~ — DONE (alpha.1)
Sessions auto-grouped by working directory in `RepoGroup.tsx`. Collapsible groups with session count.

### ~~Session Resume/Reconnect~~ — PARTIAL (0.2.x)
Claude Code and Codex transcript resume is implemented via the Resume Chat dialog (uses `--resume`/`--session-id` for Claude, `codex resume <id>` for Codex). PTYs still do not survive an Electron app restart — sessions are spawned fresh on relaunch and can pick up the prior conversation by id.

### Desktop Notifications
No notifications for background session state changes yet.

### Session Transcript Export
No export functionality yet.

### Multi-Model Quick Switch
No in-place model switching. To change models, stop the session and start a new one.

### Drag-and-Drop Reorder
Sessions are ordered by creation time. Manual reorder is post-MVP polish.

## MVP Milestones

### M1: Shell (1-2 days) — DONE
- Electron app boots with React renderer
- Basic two-panel layout: sidebar stub + terminal panel
- xterm.js renders in the terminal panel
- Single hardcoded local PTY spawning `claude` — proves the terminal works

### M2: Multi-Session (1-2 days) — DONE
- Session Manager creates/destroys sessions via the Local Adapter
- Sidebar lists sessions, click to switch
- Each session has its own xterm.js instance (hidden when not active)
- Resize propagation works across session switches
- Session stop/kill from sidebar context menu

### M3: Status Detection (1 day) — DONE
- Passive data tap on PTY output
- Status dot rendering in sidebar (green/yellow/gray/red)
- Debounced state transitions
- Heartbeat loop for dead session detection

### M4: Configuration (1 day) — DONE
- "New session" dialog: environment selection, directory picker/repo quick-pick, label, env vars, CLI flags
- Per-session environment variable injection (3-level cascade)
- JSON file persistence for session metadata
- Workspace save/restore on app restart

### M5: Polish (1-2 days) — DONE
- Keyboard shortcuts (Cmd+N, Cmd+1-9, Cmd+↑/↓)
- Sidebar visual polish: active indicator, status dots, labels
- Error handling: PTY spawn failures, invalid directories, bad API config
- Basic app menu (File → New Session, etc.)

**Total estimated MVP: 5-8 days of focused work**

## Post-MVP Roadmap (Ordered by Priority)

1. ~~**SSH Adapter**~~ — DONE (alpha.1)
2. ~~**Environment Management**~~ — DONE (alpha.1)
3. ~~**Session Resume**~~ — DONE for Claude/Codex transcript resume (0.2.x); live PTY reconnect across app restart still future
4. **Desktop Notifications** — alert when background session transitions to "waiting"
5. ~~**Container Adapter**~~ — DONE (Coder workspaces, 0.2.x)
6. **Drag-and-Drop** — reorder sessions and environment groups
7. **Transcript Export** — save session output to file
8. **Multi-Model Switch** — in-place model change with session resume

## Technical Risks

### xterm.js Performance with Many Sessions
Each session maintains its own xterm.js `Terminal` instance with its own screen buffer. With 10+ sessions, memory usage could climb. Mitigation: only the active session's xterm.js writes to the DOM. Background sessions buffer in memory only (xterm.js supports this — you can write data to a terminal that isn't attached to a DOM element, and it maintains its screen state).

### PTY Zombie Processes
If the Electron app crashes, child PTY processes might survive as orphans. Mitigation: on startup, check for stale PID entries in the registry and attempt cleanup. Also write a PID file at `~/.Tether/app.pid` for crash recovery.

### Status Detection Accuracy
Passive heuristics will never be 100% accurate. Claude Code might produce output patterns that confuse the detector (e.g., a long-running tool that produces no output for 30s+ but is still working). Mitigation: err on the side of "running" — only transition to "idle" after a generous timeout. The status dot is a hint, not a guarantee.

### Electron App Size
Electron bundles Chromium (~120MB). This is the known tradeoff for using the VS Code terminal stack. Acceptable for a developer tool.
