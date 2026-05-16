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

## What's new

We're in the **1.0 polish push**. Recent releases (0.4.x → 0.5.0-beta.1) tightened the daily-driver UX, sharpened the visual identity, and replaced cadence-only status heuristics with real CLI hooks rather than adding new surface area:

- **Customizable keyboard shortcuts** — every binding is remappable in Settings, with a reserved-chord warn list for conflicts
- **Pane keyboard navigation + broadcast** — `Alt+Arrow` to focus a neighboring pane, `Alt+Shift+Arrow` to swap, in-pane recovery overlay when a session dies, and per-pane broadcast buttons to fan a single keystroke to N selected panes
- **Smarter waiting/idle detection** — Claude Code Notification/Stop hooks drive status, replacing the prior cadence-only heuristics (local Claude sessions today; Codex + remote installs in flight)
- **UX refresh phases 1-3** — typography + spacing tokens, surface depth and motion pass, redesigned welcome pane, plus a new Tether house theme (rope/canvas/brass) alongside the Catppuccin set
- **Daily-driver UX** — drag-reorder sessions, bulk group actions, ctrl-click URLs, `Ctrl+scroll` per-pane font, `Ctrl+=/-` window zoom, configurable cursor shape/blink, configurable scrollback buffer
- **Repo bootstrapping** — start a new project end-to-end from New Session: create a folder, `git init`, and provision an empty repo on GitHub / Gitea / Azure DevOps
- **Usage history** — clickable global footer expands into Daily / Weekly / Monthly rollups with per-environment and per-CLI attribution and CSV / JSON export
- **In-app documentation** — refreshed `src/docs/*.md` pages with `(?)` deep-link icons in dialogs that jump straight to the relevant section

See the [Changelog](CHANGELOG.md) for the full release history and the [Roadmap](ROADMAP.md) for what's still on the way to 1.0.

## Why?

Agent CLIs are powerful, but managing multiple sessions across environments is painful:

- Sessions scattered across terminals, tmux panes, SSH connections, and container shells
- Context switching means remembering which tab has which repo on which machine
- SSH disconnects kill sessions; laptop sleep interrupts work
- Tools that parse and re-render CLI output break the native experience

Tether gives you a **single window** with a sidebar to manage it all — while every session stays a real PTY piped byte-for-byte into xterm.js. Claude Code and Codex CLI do not know they are being managed.

## Features

### Sessions

- **Multiple concurrent sessions** with instant switching — click in the sidebar, or `Ctrl+1`–`Ctrl+9`
- **Session grouping** by environment and working directory; collapsible groups, **drag-reorder** inside a group
- **Bulk group actions** — Kill all / Restart all / Clear all per repo group from a right-click menu
- **Split panes** *(experimental)* — drag from the sidebar into drop zones to view sessions side-by-side; keyboard-driven focus (`Alt+Arrow`) and swap (`Alt+Shift+Arrow`); in-pane recovery overlay when a session dies
- **Status indicators** — green (running), amber (waiting), gray (idle), red (dead) — passive PTY tap, no ANSI parsing
- **Workspace persistence** — sessions save on quit and restore on launch; writes are atomic (tmp → fsync → rename)
- **Resume previous chats** — pick up a prior Claude Code, Codex CLI, OpenCode, or Copilot CLI transcript on session create
- **First-run Setup Wizard** — guided setup for projects, Vault, environments, CLI defaults, and Git providers

### Environments

- **Local, SSH, and Coder** — `node-pty` locally, `ssh2` for remote, Coder REST + `coder ssh` PTY for workspaces (including creating new workspaces from templates with parameter forms and live build progress)
- **SSH host key verification** — TOFU pinning on first connect, managed known-hosts in Settings
- **Env var cascade** — app defaults → environment → launch profile → session overrides, with presets for common Claude / Codex / Copilot vars
- **Launch profiles** — named env-var + CLI-flag presets for quick-switching between configurations
- **CLI flag management** — scoped per CLI tool (Claude, Codex, OpenCode, Copilot, Custom)

### Repo bootstrapping

- **Browse + clone** from GitHub, Azure DevOps, and Gitea inside the New Session dialog
- **New folder mode** — create an empty folder under your repos root, optionally `git init` and provision a matching empty remote on GitHub / ADO / Gitea, all in one dialog
- **Tether-managed worktrees** — create a git worktree at session start with optional cleanup on session removal

### Cost & quota

- **Usage tracking** for Claude Code, Codex CLI, and OpenCode — per-session and global, computed from the CLI's own transcripts using a vendored [LiteLLM](https://github.com/BerriAI/litellm) pricing table
- **Usage history dialog** — Daily / Weekly / Monthly rollups with per-environment cost attribution
- **CSV / JSON export** of usage history for offline analysis
- **Subscription quota tracking** *(optional)* — surface your Anthropic / OpenAI quota in the sidebar footer

### Secrets

- **Vault integration** — store env vars as `vault://` references resolved at session start; KV v2 with token or OIDC auth, sidebar status pill with expiry warnings, and a tree-view picker for browsing existing secrets
- **Plaintext → Vault migration** — Settings has a one-click sweep that copies plaintext env-var values into Vault and rewrites the local config to references

### Interface

- **Customizable keyboard shortcuts** — every binding remappable in Settings, with a reserved-chord warn list for conflicts like `Ctrl+C`
- **Window zoom** — `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom UI + terminal together; `Ctrl+scroll` resizes just one pane's terminal font
- **Clickable URLs** — `Ctrl+click` any printed link to open in the system browser
- **In-app documentation** with `(?)` deep-link icons that jump from dialogs straight to the relevant docs section
- **Catppuccin themes** — Mocha, Macchiato, Frappe, Latte, plus Default Dark — applied everywhere including the title bar and docs window

### Operations

- **Auto-update** — polls GitHub Releases and notifies on new versions; toggle off in Settings if you're on a locked-down network
- **Diagnostics export** — one-click bundle of scrubbed `data.json` (SSH passwords, tokens, sensitive env-var values redacted) plus rotated logs, for triaging support issues
- **Helm** *(opt-in, personal-experimental)* — designate a session as "helm" so it can dispatch pre-briefed child sessions through the `tether-helm` MCP, including spawning Coder workspaces. Off by default behind a two-level gate. Not on the 1.0 roadmap.

> Features marked **experimental** are already useful, but may still have bugs, rough edges, or missing behavior. We label them clearly and keep iterating until they are stable.

### Supported CLI tools

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

## Network endpoints

Tether runs as a desktop client; outbound network traffic is intentionally minimal. If you're on a corporate network with egress filtering, the destinations below are what you'll need to allow.

| Destination | Purpose | Source |
|---|---|---|
| `api.github.com`, `github.com` | Auto-update check (latest GitHub Release polling) and downloading installers from the Releases page. | `src/main/update/update-checker.ts` |
| `raw.githubusercontent.com` | Daily refresh of LiteLLM model pricing JSON. Falls back to the bundled snapshot if blocked. | `src/main/usage/pricing-fetcher.ts` |
| Your Vault server | Resolving `vault://` env-var references at session start. Only contacted when Vault integration is configured. | `src/main/vault/` |
| Your SSH host(s) | SSH-transport sessions and managed git worktree clones. Only contacted for environments you create. | `src/main/transport/ssh-transport.ts` |
| Your Coder server | Coder workspace listing, creation, and PTY exec. Only contacted when Coder integration is configured. | `src/main/transport/coder-transport.ts` |

The auto-update check and pricing refresh are the only "always-on" outbound calls; both fail silently and never block the app from launching. Disable the update check from **Settings → Updates** if you'd prefer no GitHub egress at all.

## Documentation

User-facing docs ship inside Tether — open the Documentation window from the View menu, or click any `(?)` icon in a dialog to deep-link straight to the relevant section. Source markdown is in [`src/docs/`](src/docs/) (Getting Started, Sessions, Environments, Vault, Git Providers, Usage & Quota, Helm, Keyboard Shortcuts, Settings).

Contributor / design docs:

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | System design, component diagram, IPC, data schema |
| [Transport Design](docs/TRANSPORT_DESIGN.md) | Transport interface, Local/SSH adapter specs, data flow |
| [UI Design](docs/UI_DESIGN.md) | Layout, sidebar, terminal panel, interaction model |
| [Product Spec](docs/PRODUCT_SPEC.md) | Vision, user stories, feature requirements |
| [Roadmap](ROADMAP.md) | Pre-1.0 polish plan and post-1.0 plans |
| [Changelog](CHANGELOG.md) | Release history |

## Contributing

Tether is in active development. If you're interested in contributing, check the [Architecture](docs/ARCHITECTURE.md) doc to understand the codebase, then look at the open issues.

## License

[MIT](LICENSE)
