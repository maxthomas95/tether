# Tether

A unified control plane for managing Claude Code sessions across local, remote, and containerized environments.

## The Problem

Claude Code is the best agentic coding tool available, but managing multiple sessions across different environments is painful:

- **No single pane of glass.** You have sessions scattered across terminals, tmux panes, SSH connections, and container shells. There's no unified view of what's running where.
- **Context switching is manual.** Hopping between sessions means remembering which terminal tab has which repo, which VM is running what, and whether that session is still alive.
- **Remote sessions are fragile.** SSH disconnects kill sessions. Laptop sleep interrupts work. There's no persistent connection layer.
- **Existing tools compromise the native feel.** Tools that parse and re-render Claude Code output lose the terminal experience — spinners, tool call rendering, permission prompts, keyboard shortcuts all break.

## The Solution

Tether is a desktop application that multiplexes Claude Code sessions through a clean sidebar interface while preserving the **exact native terminal experience.** Every session is a real PTY piped byte-for-byte into xterm.js — Claude Code doesn't know it's being managed.

### Core Principles

1. **Dumb pipe, smart shell.** Never parse, intercept, or re-render Claude Code's output. The PTY stream flows untouched into xterm.js. Status detection is a passive side-channel, not an interceptor.
2. **Adapter pattern for environments.** Local repos, SSH VMs, and container workspaces all implement the same transport interface. The UI doesn't know or care where a session lives.
3. **Native feel is non-negotiable.** If it works in a raw terminal, it works in Tether. `/voice`, `Ctrl+T` tasks, slash commands, permission prompts, thinking indicators — all preserved.

## Features

- **Multiple concurrent sessions** — run 10+ Claude Code sessions with instant switching
- **Local and SSH sessions** — local PTY via node-pty, remote sessions via ssh2
- **Sidebar with status indicators** — green (running), amber (waiting), gray (idle), red (dead)
- **Session grouping** — auto-grouped by working directory with collapsible groups
- **Environment management** — preconfigured environments for Local and SSH with per-environment settings
- **Environment variable cascade** — app defaults -> environment -> session overrides, with quick-add presets for common Claude Code vars
- **CLI flag management** — app-wide and per-session flags (e.g., `--dangerously-skip-permissions`, `--verbose`)
- **Workspace persistence** — sessions auto-save on quit and restore on next launch
- **Catppuccin themes** — Mocha, Macchiato, Frappe, Latte, plus Default Dark
- **Keyboard shortcuts** — Ctrl+N (new), Ctrl+1-9 (switch), Ctrl+Up/Down (navigate), Ctrl+B (sidebar), Ctrl+W (stop)
- **Custom titlebar** — themed overlay with branded menubar

## Documentation

- [Product Spec](PRODUCT_SPEC.md) — Vision, user stories, and feature requirements
- [Architecture](ARCHITECTURE.md) — System architecture and component design
- [MVP Scope](MVP_SCOPE.md) — Original MVP milestones and post-MVP roadmap
- [Transport Design](TRANSPORT_DESIGN.md) — The adapter/transport layer in detail
- [UI Design](UI_DESIGN.md) — Layout, sidebar, terminal panel, and interaction model
- [Changelog](CHANGELOG.md) — Release history

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Shell | Electron 41 | Cross-platform, native window management, IPC |
| Frontend | React 19 + TypeScript | Component model, ecosystem |
| Terminal | xterm.js 6.0 + xterm-addon-fit | Full VT emulation, VS Code's terminal engine |
| Local PTY | node-pty | Real pseudo-terminal, same lib as VS Code |
| SSH | ssh2 (Node) | Pure JS SSH client, PTY channel support |
| State | JSON file persistence | Embedded, zero-config (SQLite deferred due to ABI issues) |
| IPC | Electron IPC | Main<->renderer commands + event channels |
| Build | Electron Forge + Vite | Fast dev server, optimized production builds |

## Build & Run

```bash
npm install          # Install dependencies
npm run start        # Launch in dev mode (Electron Forge + Vite)
npx electron .       # Direct launch (no Vite dev server for renderer)
```

## Status

**v0.1.2-alpha.3** — Local and SSH sessions, environment management, theming, workspace persistence. See [CHANGELOG.md](CHANGELOG.md) for details.
