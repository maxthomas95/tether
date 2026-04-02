# CLAUDE.md — Tether

## Project Overview

Tether is a desktop session multiplexer for Claude Code. It provides a single unified interface to manage multiple Claude Code sessions across local, SSH, and containerized (Coder) environments — preserving the exact native terminal experience via raw PTY piping into xterm.js.

**Status:** Design/spec phase. No source code yet. All documentation is complete and ready for implementation.

## Core Principle

**Dumb pipe, smart shell.** Never parse, intercept, or re-render Claude Code output. The PTY stream flows byte-for-byte into xterm.js untouched. Status detection is a passive side-channel tap on output cadence, not an interceptor.

## Tech Stack

- **Shell:** Electron (main process owns PTY lifecycle, renderer owns UI)
- **Frontend:** React + TypeScript
- **Terminal:** xterm.js + xterm-addon-fit (same as VS Code)
- **Local PTY:** node-pty
- **SSH:** ssh2 (Node.js)
- **State:** SQLite via better-sqlite3 (~/.Tether/sessions.db)
- **IPC:** Electron IPC (commands) + event channel (PTY data streaming)
- **Secrets:** Electron safeStorage for API key encryption at rest

## Architecture

- **Main process:** Session Manager, Transport Adapters (Local/SSH/Container), Session Registry (SQLite), Status Detector
- **Renderer process:** React UI — Sidebar (session list + groups), Terminal Panel (xterm.js), Config dialogs
- **Transport interface:** All adapters implement `SessionTransport` — the UI is environment-agnostic
- **Data flow:** Keystroke -> xterm.js -> IPC -> transport.write() -> PTY stdin -> Claude Code -> PTY stdout -> status detector (copy) + IPC -> xterm.js -> screen

## Key Documentation

| File | Contents |
|---|---|
| `README.md` | Project intro, problem/solution, core principles |
| `PRODUCT_SPEC.md` | Vision, target user, user stories (SF-01 through SF-34), non-goals |
| `MVP_SCOPE.md` | MVP definition, 5 milestones (M1-M5), post-MVP roadmap, technical risks |
| `ARCHITECTURE.md` | System diagram, component design, DB schema, IPC design, key decisions |
| `TRANSPORT_DESIGN.md` | Transport interface (TypeScript), Local/SSH/Container adapter specs, data flow |
| `UI_DESIGN.md` | Layout mockups, sidebar, terminal panel, dialogs, keyboard shortcuts, visual design |

## Development Guidelines

### When implementing

- Start from the MVP milestones in `MVP_SCOPE.md` (M1 through M5)
- Follow the architecture in `ARCHITECTURE.md` — main process owns PTYs, renderer owns UI
- Use the `SessionTransport` interface from `TRANSPORT_DESIGN.md` as the contract for all adapters
- Follow UI specs in `UI_DESIGN.md` for layout, colors, keyboard shortcuts
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

**Note:** Native modules (node-pty, better-sqlite3) have ABI issues with VS 2025 + Electron 41. Workarounds: JSON persistence instead of SQLite, lazy node-pty import. See memory/dev_environment.md.

## File Structure

```
src/
  main/index.ts              # Electron main entry
  main/ipc/handlers.ts       # IPC handler registry
  main/session/session-manager.ts  # Session lifecycle + transport factory
  main/transport/types.ts     # SessionTransport interface
  main/transport/local-transport.ts  # Local PTY via node-pty
  main/transport/ssh-transport.ts    # SSH via ssh2
  main/status/status-detector.ts     # Passive PTY status detection
  main/db/database.ts         # JSON file persistence
  main/db/environment-repo.ts # Environment CRUD
  main/db/session-repo.ts     # Session CRUD
  preload/preload.ts          # contextBridge IPC API
  renderer/App.tsx             # Root React component
  renderer/components/         # TerminalPanel, sidebar/, dialogs
  renderer/hooks/              # useTerminalManager, useKeyboardShortcuts
  renderer/styles/global.css   # Dark theme + all component styles
  shared/types.ts              # Shared TS interfaces
  shared/constants.ts          # IPC channel names
```

**Important:** The preload entry is `src/preload/preload.ts` (not `index.ts`) to avoid Vite output collision with main process `index.js` in `.vite/build/`.
