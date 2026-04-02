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
4. **OpenRouter-first.** Every session can be configured with its own API backend. OpenRouter env vars are injected at spawn time per-session.

## Documentation

- [Product Spec](docs/PRODUCT_SPEC.md) — Vision, user stories, and feature requirements
- [Architecture](docs/ARCHITECTURE.md) — System architecture and component design
- [Design Decisions](docs/DESIGN_DECISIONS.md) — Key decisions with rationale (platform, auth model, secrets, etc.)
- [MVP Scope](docs/MVP_SCOPE.md) — What's in and out for the first usable build
- [Transport Design](docs/TRANSPORT_DESIGN.md) — The adapter/transport layer in detail
- [UI Design](docs/UI_DESIGN.md) — Layout, sidebar, terminal panel, and interaction model

## Tech Stack (Planned)

| Layer | Technology | Rationale |
|---|---|---|
| Shell | Electron | Cross-platform, native window management, IPC |
| Frontend | React + TypeScript | Component model, ecosystem |
| Terminal | xterm.js + xterm-addon-fit | Full VT emulation, VS Code's terminal engine |
| Local PTY | node-pty | Real pseudo-terminal, same lib as VS Code |
| SSH | ssh2 (Node) | Pure JS SSH client, PTY channel support |
| State | SQLite (better-sqlite3) | Embedded, zero-config, fast reads |
| IPC | Electron IPC + WebSocket | Main↔renderer events, real-time status |
| API Backend | OpenRouter via env vars | Per-session `ANTHROPIC_BASE_URL` injection |

## Status

**Phase: Design / Spec**