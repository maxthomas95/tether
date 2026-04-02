# MVP Scope — Tether

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
- Session list persists across app restarts (SQLite)
- Running PTYs do NOT persist across app restarts (PTY dies with the Electron process)
- On restart, previously-running sessions show as "stopped" and can be manually restarted

### Status Detection
- Passive byte-stream tap (no ANSI parsing)
- Green (active output), yellow (waiting), gray (idle), red (dead)
- Debounced transitions to prevent flicker

## Out of Scope (MVP)

### SSH Adapter
The SSH adapter is the immediate follow-up after MVP, but it adds significant complexity: connection management, reconnection logic, remote host validation, key handling. Ship MVP without it, then add it as the first post-MVP feature.

### Container/Coder Adapter
Requires API integration with Coder or Docker. Post-MVP.

### Environment Management UI
MVP has a simple "new session" dialog where you pick a directory and optionally set API config. The full environment registry (named environments with grouped sessions) comes in the next phase.

### Session Grouping in Sidebar
MVP sidebar is a flat list. Grouping by environment comes when the environment management UI ships.

### Session Resume/Reconnect
If a PTY dies, the session is marked dead. No automatic reconnect. No Claude Code `--resume` integration. Future feature.

### Desktop Notifications
No notifications for background session state changes in MVP.

### Session Transcript Export
No export functionality in MVP.

### Multi-Model Quick Switch
No in-place model switching. To change models, stop the session and start a new one.

### Drag-and-Drop Reorder
Sessions are ordered by creation time in MVP. Manual reorder is post-MVP polish.

## MVP Milestones

### M1: Shell (1-2 days)
- Electron app boots with React renderer
- Basic two-panel layout: sidebar stub + terminal panel
- xterm.js renders in the terminal panel
- Single hardcoded local PTY spawning `claude` — proves the terminal works

### M2: Multi-Session (1-2 days)
- Session Manager creates/destroys sessions via the Local Adapter
- Sidebar lists sessions, click to switch
- Each session has its own xterm.js instance (hidden when not active)
- Resize propagation works across session switches
- Session stop/kill from sidebar context menu

### M3: Status Detection (1 day)
- Passive data tap on PTY output
- Status dot rendering in sidebar (green/yellow/gray/red)
- Debounced state transitions
- Heartbeat loop for dead session detection

### M4: Configuration (1 day)
- "New session" dialog: directory picker, label, API config fields
- Per-session OpenRouter env var injection
- SQLite persistence for session metadata
- Session list restored on app restart (as stopped sessions)

### M5: Polish (1-2 days)
- Keyboard shortcuts (Cmd+N, Cmd+1-9, Cmd+↑/↓)
- Sidebar visual polish: active indicator, status dots, labels
- Error handling: PTY spawn failures, invalid directories, bad API config
- Basic app menu (File → New Session, etc.)

**Total estimated MVP: 5-8 days of focused work**

## Post-MVP Roadmap (Ordered by Priority)

1. **SSH Adapter** — remote VM sessions, environment registry, connection management
2. **Environment Management** — named environments, grouped sidebar, per-env defaults
3. **Session Resume** — reconnect to still-alive PTYs on app restart, Claude `--resume` integration
4. **Desktop Notifications** — alert when background session transitions to "waiting"
5. **Container Adapter** — Docker/Coder workspace integration
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
