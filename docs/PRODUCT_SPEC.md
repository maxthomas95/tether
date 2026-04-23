# Product Spec — Tether

> **Note:** This document was the original product spec written before implementation. As of v0.3.x, all SF-01 through SF-23 stories are implemented, plus several originally-future items (SF-30 Coder, SF-31 workspace persistence, SF-33 transcript browsing for resume). Tether also now supports Codex CLI as a first-class peer, OpenCode and custom binaries as raw PTY sessions, Vault-backed env vars, and per-session usage/cost tracking. Stories are annotated with their status below.

## Vision

Tether is a session multiplexer for Claude Code. It solves one problem well: letting a developer see, switch between, and manage all their Claude Code sessions — wherever those sessions are running — from a single interface that preserves the native terminal experience exactly.

It is NOT an orchestration framework, a task management system, or an agent workflow tool. Those layers can be built on top later. Tether is the shell — the place where sessions live.

## Target User

A developer who:
- Runs multiple Claude Code sessions simultaneously (3-10+ at a time)
- Works across multiple environments (local repos, remote VMs, dev containers)
- Uses OpenRouter or direct Anthropic API as their backend
- Values the native Claude Code terminal experience and does not want it abstracted away
- Wants to glance at a sidebar and know which sessions are active, which are waiting, and which are idle

## User Stories

### Session Lifecycle

**SF-01: Start a new local session** — DONE
As a developer, I want to create a new Claude Code session in a local directory so I can start working on a task. I pick a directory (or type a path), optionally set a label, and a new session appears in the sidebar. Claude Code launches in the terminal panel.

**SF-02: Start a new remote session** — DONE
As a developer, I want to create a Claude Code session on a remote VM so I can work on code that lives on that machine. I select a pre-configured SSH environment, pick or type a remote directory, and the session launches over SSH. The terminal experience is indistinguishable from local.

**SF-03: Stop a session** — DONE
As a developer, I want to stop a running session cleanly. Claude Code receives the appropriate signal, the PTY closes, and the session moves to a "stopped" state in the sidebar. I can see the last output before it stopped.

**SF-04: Resume a session** — PARTIAL (transcript resume done; live PTY reconnect not)
As a developer, I want to reconnect to a Claude Code session that I previously detached from (or that survived a laptop sleep). The Resume Chat dialog lets me pick from prior Claude/Codex transcripts and re-launch with the conversation restored (`--resume` for Claude, `codex resume` for Codex). True live PTY reconnect across app restart is not yet implemented — sessions are spawned fresh.

**SF-05: Kill a stuck session** — DONE
As a developer, I want to force-kill a session that's not responding. SIGKILL the PTY process, clean up resources, mark as dead in the registry.

### Session Navigation

**SF-10: Switch between sessions** — DONE
As a developer, I want to click a session in the sidebar (or use a keyboard shortcut) to instantly switch the terminal panel to that session's PTY stream. Switching is instant — no reload, no re-render. The xterm.js instance for each session stays alive in the background.

**SF-11: See session status at a glance** — DONE
As a developer, I want to see a colored indicator on each session in the sidebar:
- **Green** — Claude is actively producing output (tool calls running, response streaming)
- **Yellow/Amber** — Claude is waiting for user input (the `>` prompt is showing)
- **Gray** — Session is idle or backgrounded (no recent activity)
- **Red** — Session is dead/errored (PTY exited, SSH disconnected)

**SF-12: Group sessions by environment** — DONE (grouped by working directory, not environment type)
As a developer, I want my sessions organized by environment in the sidebar. All local sessions together, all sessions on VM-A together, all Coder workspace sessions together. I can collapse/expand groups.

**SF-13: Label and reorder sessions** — PARTIAL (labeling done via inline rename; drag reorder not yet implemented)
As a developer, I want to give sessions a short label ("NKP OIDC fix", "VoidCode GPU pipeline") so I can identify them at a glance. I want to drag sessions to reorder within their group.

**SF-14: Quick-switch with keyboard** — DONE
As a developer, I want to press a hotkey (e.g., `Cmd+1` through `Cmd+9`, or `Cmd+↑/↓`) to jump between sessions without touching the mouse.

### Environment Management

**SF-20: Configure a local environment** — DONE
As a developer, I want to register a local directory as a named environment. Sessions created against it inherit its label, default model config, and env vars.

**SF-21: Configure an SSH environment** — DONE
As a developer, I want to register a remote host as a named environment. I provide: hostname, SSH user, identity file path, and optionally a default working directory. Tether validates the connection on save.

**SF-22: Configure per-environment API settings** — DONE (via env var editor, not dedicated auth UI)
As a developer, I want each environment to have its own API backend config:
- `ANTHROPIC_BASE_URL` (e.g., `https://openrouter.ai/api` or direct Anthropic)
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL` (optional override)
- `ANTHROPIC_SMALL_FAST_MODEL` (optional override)

Sessions inherit these from their environment, but I can override per-session.

**SF-23: Configure per-session API settings** — DONE (via env var overrides in New Session dialog)
As a developer, I want to override the model or API key for a specific session without changing the environment defaults. Use case: running one session on Opus for complex architecture work while the rest use Sonnet.

### Future (Post-MVP)

**SF-30: Container/Coder adapter** — DONE (0.2.x)
Coder workspace integration with two flows: connect to an existing workspace, or create a new one from a template (with parameter forms and live progress). Self-signed certs supported.

**SF-31: Session persistence across app restarts** — DONE (workspace save/restore)
When I quit and reopen Tether, my session list is restored. Toggle in Settings. PTYs don't survive app restart — sessions are recreated as new processes. True PTY reconnection is not yet implemented.

**SF-32: Notification on session state change**
Desktop notification when a background session transitions from "active" to "waiting for input" — so I know when Claude needs me.

**SF-33: Session log/transcript export**
Export a session's terminal output (raw or cleaned) to a file for documentation or sharing. Browsing prior Claude/Codex transcripts (for resume) is implemented; explicit export-to-file is not.

**SF-34: Multi-model quick switch**
A dropdown or hotkey to re-launch the current session with a different model (e.g., switch from Sonnet to Opus mid-task by spawning a new Claude Code process with `--resume` and a different `ANTHROPIC_MODEL`).

## Non-Goals

- **Custom rendering of Claude Code output.** We never parse the ANSI stream to build a "prettier" UI. The terminal IS the UI.
- **Built-in task management.** Claude Code has native tasks (`Ctrl+T`). We don't duplicate this.
- **Agent orchestration.** No multi-agent coordination, no task queues, no swarm logic. Tether manages sessions, not agents.
- **Web-based access.** MVP is a desktop app. A web version (for accessing sessions from a phone/tablet) is a future possibility but out of scope.
- **Broad model-agnostic agent support.** Claude Code and Codex CLI are first-class targets (with session resume + transcript browsing). OpenCode and arbitrary "Custom" binaries run as raw PTY sessions without tool-specific integration. Other agents (Aider, Gemini CLI, etc.) are a nice-to-have extension, not a design driver.

## Success Metrics

- I can manage 10+ simultaneous Claude Code sessions without confusion
- Switching sessions takes < 100ms (perceptual instant)
- Claude Code's native behavior is 100% preserved — every feature, every keybinding
- A new SSH environment can be configured in under 60 seconds
- The sidebar gives me accurate, real-time status on every session without me having to switch to each one
