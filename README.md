<p align="center">
  <img src="src/renderer/assets/logo.png" alt="Tether" width="160" />
</p>

<h1 align="center">Tether</h1>

<p align="center">
  A desktop session multiplexer for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, Codex CLI, and other agent CLIs.<br/>
  Manage multiple sessions across local, SSH, and Coder workspace environments — with the full native terminal experience.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/status-beta-green" alt="Status" />
  <a href="https://sonarcloud.io/summary/new_code?id=maxthomas95_tether"><img src="https://sonarcloud.io/api/project_badges/measure?project=maxthomas95_tether&metric=alert_status" alt="Quality Gate Status" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=maxthomas95_tether"><img src="https://sonarcloud.io/api/project_badges/measure?project=maxthomas95_tether&metric=security_rating" alt="Security Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=maxthomas95_tether"><img src="https://sonarcloud.io/api/project_badges/measure?project=maxthomas95_tether&metric=sqale_rating" alt="Maintainability Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=maxthomas95_tether"><img src="https://sonarcloud.io/images/project_badges/sonarcloud-dark.svg" alt="SonarQube Cloud" /></a>
</p>

<p align="center">
  <img src="screenshot.png" alt="Tether screenshot" width="800" />
</p>

---

## Download

Grab the latest release from [GitHub Releases](https://github.com/maxthomas95/tether/releases):

- **Setup installer** — `Tether-x.y.z-Setup.exe` (recommended)
- **Portable zip** — `Tether-x.y.z-portable.zip` (no install required)

> Windows only for now. Linux and macOS support planned.

## Why?

Agent CLIs are powerful, but managing multiple sessions across environments is painful:

- Sessions scattered across terminals, tmux panes, SSH connections, and container shells
- Context switching means remembering which tab has which repo on which machine
- SSH disconnects kill sessions; laptop sleep interrupts work
- Tools that parse and re-render CLI output break the native experience

Tether gives you a **single window** with a sidebar to manage it all — while every session stays a real PTY piped byte-for-byte into xterm.js. Claude Code and Codex CLI do not know they are being managed.

## Features

- **Multiple concurrent sessions** with instant switching
- **Split panes** (experimental) — view multiple sessions side-by-side; drag panes between drop zones to rearrange layouts
- **Local, SSH, and Coder environments** — node-pty locally, ssh2 for remote, Coder REST API for workspaces
- **First-run Setup Wizard** — guided configuration for your first environment and CLI tool
- **SSH host key verification** — TOFU pinning on first connect, managed known-hosts in settings
- **Status indicators** — green (running), amber (waiting), gray (idle), red (dead)
- **Session grouping** — auto-grouped by working directory, collapsible
- **Environment management** — preconfigured environments with per-env settings
- **Env var cascade** — app defaults &rarr; environment &rarr; session overrides, with presets for common Claude Code and Codex CLI vars
- **Vault integration** — store env vars as `vault://` references; KV v2 with token or OIDC auth, sidebar status pill, and a tree-view picker for browsing existing secrets
- **Tether-managed worktrees** — create a git worktree at session start, with optional cleanup on session removal
- **Repo browse + clone-on-session-start** — browse Azure DevOps and Gitea repos and clone them as part of session creation
- **Helm** (experimental, opt-in) — designate a session as "helm" so it can dispatch pre-briefed child sessions through an MCP server, including spawning Coder workspaces
- **CLI flag management** — app-wide, per-profile, and per-session flags scoped by CLI tool
- **Usage tracking** (experimental) — optional quota and cost views in the sidebar and per-session panes
- **Other CLI tools** — also supports Codex CLI, GitHub Copilot CLI, OpenCode, and custom binaries (see below)
- **Workspace persistence** — sessions save on quit, restore on launch
- **Resume previous chats** — pick up where Claude Code or Codex CLI left off
- **Auto-update** — checks GitHub Releases and notifies on new versions
- **Catppuccin themes** — Mocha, Macchiato, Frappe, Latte, plus Default Dark
- **Keyboard shortcuts** — `Ctrl+N` new, `Ctrl+1-9` switch, `Ctrl+B` toggle sidebar, `Ctrl+W` stop

> Features marked **experimental** are already useful, but may still have bugs, rough edges, or missing behavior. We label them clearly and keep iterating until they are stable.

### Other CLI tools

Tether is a dumb-pipe PTY multiplexer for interactive coding CLIs. You can select a CLI tool per session:

- **Claude Code** (`claude`) — full support including session resume and transcript browsing
- **Codex CLI** (`codex`) — OpenAI's coding agent, with session resume and transcript browsing for local sessions
- **GitHub Copilot CLI** (`copilot`) — session resume via `--resume`
- **OpenCode** (`opencode`)
- **Custom** — any binary you specify

OpenCode and custom tools run as raw PTY sessions without tool-specific resume support.

## Core Principle

> **Dumb pipe, smart shell.** Never parse, intercept, or re-render CLI output. The PTY stream flows untouched into xterm.js. Status detection is a passive side-channel tap, not an interceptor.

## Quick Start

Download a release (see above), or build from source:

```bash
npm install       # install dependencies
npm run start     # launch in dev mode (Electron Forge + Vite)
```

## Tech Stack

| | Technology | Why |
|---|---|---|
| Shell | Electron 41 | Cross-platform, native window management, IPC |
| Frontend | React 19 + TypeScript | Component model, ecosystem |
| Terminal | xterm.js 6.0 | Full VT emulation — same engine as VS Code |
| Local PTY | node-pty | Real pseudo-terminal, same lib as VS Code |
| SSH | ssh2 | Pure JS SSH client with PTY channel support |
| Coder | Coder REST API + SSH PTY | Connect to or create Coder workspaces from templates |
| Secrets | HashiCorp Vault (KV v2) | Reference secrets via `vault://` instead of plaintext config |
| State | JSON file persistence | Embedded, zero-config |
| Build | Electron Forge + Vite | Fast dev server, optimized production builds |

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | System design, component diagram, IPC, data schema |
| [Transport Design](docs/TRANSPORT_DESIGN.md) | Transport interface, Local/SSH adapter specs, data flow |
| [UI Design](docs/UI_DESIGN.md) | Layout, sidebar, terminal panel, interaction model |
| [Product Spec](docs/PRODUCT_SPEC.md) | Vision, user stories, feature requirements |
| [MVP Scope](docs/MVP_SCOPE.md) | Original MVP definition and milestones |
| [Roadmap](ROADMAP.md) | Pre-1.0 polish plan and post-1.0 plans |
| [Changelog](CHANGELOG.md) | Release history |

## Contributing

Tether is in active development. If you're interested in contributing, check the [Architecture](docs/ARCHITECTURE.md) doc to understand the codebase, then look at the open issues.

## License

[MIT](LICENSE)
