# CLAUDE.md — Tether

## Project Overview

Tether is a desktop session multiplexer for Claude Code. It provides a single unified interface to manage multiple Claude Code sessions across local, SSH, and containerized (Coder) environments — preserving the exact native terminal experience via raw PTY piping into xterm.js.

**Status:** Active development. v0.1.2-alpha.3 released. Local and SSH sessions working, environment management, theming, and workspace persistence implemented.

## Core Principle

**Dumb pipe, smart shell.** Never parse, intercept, or re-render Claude Code output. The PTY stream flows byte-for-byte into xterm.js untouched. Status detection is a passive side-channel tap on output cadence, not an interceptor.

## Tech Stack

- **Shell:** Electron (main process owns PTY lifecycle, renderer owns UI)
- **Frontend:** React + TypeScript
- **Terminal:** xterm.js + xterm-addon-fit (same as VS Code)
- **Local PTY:** node-pty
- **SSH:** ssh2 (Node.js)
- **State:** JSON file persistence (`{userData}/data.json`) — SQLite planned but deferred due to native module ABI issues
- **IPC:** Electron IPC (commands + event channels for PTY data streaming)
- **Themes:** Catppuccin (Mocha, Macchiato, Frappe, Latte) + Default Dark

## Architecture

- **Main process:** Session Manager, Transport Adapters (Local/SSH), Session Registry (JSON), Status Detector
- **Renderer process:** React UI — Sidebar (session list + groups), Terminal Panel (xterm.js), Config dialogs
- **Transport interface:** All adapters implement `SessionTransport` — the UI is environment-agnostic
- **Data flow:** Keystroke -> xterm.js -> IPC -> transport.write() -> PTY stdin -> Claude Code -> PTY stdout -> status detector (copy) + IPC -> xterm.js -> screen

## Key Documentation

| File | Contents |
|---|---|
| `README.md` | Project intro, problem/solution, core principles |
| `CHANGELOG.md` | Release history with features and known issues per version |
| `docs/PRODUCT_SPEC.md` | Vision, target user, user stories (SF-01 through SF-34), non-goals |
| `docs/MVP_SCOPE.md` | Original MVP definition, milestones (M1-M5), post-MVP roadmap |
| `docs/ARCHITECTURE.md` | System diagram, component design, data schema, IPC design, key decisions |
| `docs/TRANSPORT_DESIGN.md` | Transport interface (TypeScript), Local/SSH adapter specs, data flow |
| `docs/UI_DESIGN.md` | Layout mockups, sidebar, terminal panel, dialogs, keyboard shortcuts, visual design |

## Development Guidelines

### When implementing

- Start from the MVP milestones in `docs/MVP_SCOPE.md` (M1 through M5)
- Follow the architecture in `docs/ARCHITECTURE.md` — main process owns PTYs, renderer owns UI
- Use the `SessionTransport` interface from `docs/TRANSPORT_DESIGN.md` as the contract for all adapters
- Follow UI specs in `docs/UI_DESIGN.md` for layout, colors, keyboard shortcuts
- Dark theme by default. Status colors: green (#22C55E), amber (#EAB308), gray (#6B7280), red (#EF4444)

### Session grouping

Sessions are grouped by environment (Local, SSH host, Coder workspace). Multiple sessions can exist in the same repo/directory on the same machine. Groups are collapsible in the sidebar. This is a core feature, not a post-MVP nice-to-have.

### Multi-environment support

The user runs Claude Code sessions across:
1. **Local PC** (Windows) — local PTY via node-pty
2. **Linux VM** (via SSH) — SSH adapter with preconfigured host/key/directory
3. **Coder workspaces** — connect to existing workspaces or spin up new ones via Coder API

Each environment has preconfigured settings (host, auth, default directory, API config). Creating a new session in a known environment should be fast — pick environment, optionally override directory/label, go.

### What NOT to do

- Never parse or filter ANSI output — raw bytes only
- Never abstract away the Claude Code terminal experience
- Don't build task management, agent orchestration, or custom rendering
- Don't store SSH private keys — reference paths only
- Don't send PTY data for background sessions to the renderer — only the active session streams to the DOM

## Build & Run

```bash
npm install          # Install dependencies
npm run start        # Launch in dev mode (Electron Forge + Vite)
npx electron .       # Direct launch (no Vite dev server for renderer)
```

**Note:** Native modules (node-pty) have ABI issues with VS 2025 + Electron 41. Workarounds: lazy node-pty import, JSON persistence instead of SQLite. `better-sqlite3` is in package.json but unused — JSON file storage is the current persistence layer.

## File Structure

```
src/
  main/index.ts                  # Electron main entry
  main/ipc/handlers.ts           # IPC handler registry (25 channels)
  main/session/session-manager.ts    # Session lifecycle + transport factory
  main/transport/types.ts         # SessionTransport interface
  main/transport/local-transport.ts  # Local PTY via node-pty
  main/transport/ssh-transport.ts    # SSH via ssh2
  main/status/status-detector.ts     # Passive PTY status detection
  main/db/database.ts             # JSON file persistence
  main/db/environment-repo.ts     # Environment CRUD
  main/db/session-repo.ts         # Session CRUD
  preload/preload.ts              # contextBridge IPC API
  renderer/index.tsx              # React entry point
  renderer/App.tsx                # Root React component
  renderer/components/
    TerminalPanel.tsx             # xterm.js container + resize handling
    SettingsDialog.tsx            # App-wide settings (theme, env vars, CLI flags)
    EnvVarEditor.tsx              # Reusable env var editor with presets
    sidebar/
      NewSessionDialog.tsx        # Session creation with env selection, repo pick, env vars, CLI flags
      NewEnvironmentDialog.tsx    # Environment creation (Local/SSH config)
      RepoGroup.tsx               # Groups sessions by working directory
      SessionItem.tsx             # Session row with context menu + inline rename
      SidebarResizeHandle.tsx     # Draggable sidebar resize (180-400px)
  renderer/hooks/
    useTerminalManager.ts         # xterm.js instance lifecycle per session
    useKeyboardShortcuts.ts       # App-level keyboard shortcuts
    useTheme.ts                   # Theme loading, CSS variable application, titlebar sync
  renderer/styles/
    global.css                    # Component styles + CSS variable theming
    themes.ts                     # 5 theme definitions (Catppuccin + Default Dark)
  renderer/assets/
    logo.png                      # App logo for menubar
    assets.d.ts                   # Type declarations for image imports
  shared/types.ts                 # Shared TS interfaces (TetherAPI, session/env types)
  shared/constants.ts             # IPC channel name constants
```

**Important:** The preload entry is `src/preload/preload.ts` (not `index.ts`) to avoid Vite output collision with main process `index.js` in `.vite/build/`.
