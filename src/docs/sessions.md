# Sessions

A **session** in Tether is a running CLI process in a specific directory and environment. You can have many sessions open at once, each with its own terminal. Tether is a "dumb pipe" — the PTY stream flows byte-for-byte into the terminal; nothing is parsed, rewritten, or intercepted.

## Creating Sessions

Click **+ New session** or press **Ctrl+N**. The dialog has three tabs for picking a working directory:

- **Existing** — browse to or paste a path you already use
- **Clone** — clone a remote repo via a configured Git provider (see [Git Providers](git-providers))
- **New folder** — create an empty folder under your repos root, optionally `git init` and provision an empty remote (see [Git Providers](git-providers#new-folder)). New folder mode is local-only.

Other fields:

- **Environment** — Local, SSH, or Coder (see [Environments](environments))
- **CLI tool** — [Claude Code](#multi-cli-support), [Codex CLI](#multi-cli-support), [GitHub Copilot CLI](#multi-cli-support), [OpenCode](#multi-cli-support), or a [Custom](#multi-cli-support) binary
- **Label** — optional display name (defaults to the directory name)
- **Launch profile** — preset env vars and CLI flags (see [Settings](settings#launch-profiles))
- **Environment variables** — key-value pairs passed to the CLI process. Values can be `vault://` references; see [Vault](vault).
- **CLI flags** — additional command-line arguments. Multi-token flags like `--permission-mode plan` are tokenized at the transport boundary.

### Git worktrees (local only)

When the Existing tab points to a git repository, a **Create as new git worktree** checkbox appears. Check it, type a branch name, and Tether will `git worktree add` a new working tree alongside the repo before spawning the session. The worktree path auto-fills from the branch name but can be edited. Useful for running parallel agent sessions on different branches of the same repo without juggling stashes or clones.

## Resume Conversation

When you create a Local Claude Code or Codex CLI session in a directory with existing transcripts, Tether offers to resume a previous conversation. Click a transcript preview to start from where you left off (uses `claude --resume` / `codex resume <id>` under the hood). Resume is not currently supported for Coder sessions because transcripts live inside the workspace.

## Multi-CLI Support

Tether is CLI-agnostic. The CLI registry lives in `src/shared/cli-tools.ts`; per-CLI quirks (resume args, default flags, transcript reader) are kept there rather than scattered through transports.

| Tool | Notes |
|------|-------|
| **Claude Code** | Full integration: resume (`--resume`, `--session-id`), transcript browsing, hooks-based status detection. |
| **Codex CLI** | Full integration: `codex resume <id>`, transcript browsing, session-id watcher captures `sessionId` at spawn, hooks-based status detection. |
| **GitHub Copilot CLI** | Resume support, transcript browsing. |
| **OpenCode** | Cost tracking from OpenCode's local DB. No transcript-based resume. |
| **Custom** | Any binary you specify. No resume, no transcript reader. |

## Session States

Each session has a state, shown by the colored dot in the sidebar:

| State | Color | Meaning |
|-------|-------|---------|
| **Running** | Green | The CLI is actively generating output |
| **Waiting** | Amber | The CLI is paused on a prompt (input, permission, tool approval) |
| **Idle** | Gray | Session is alive but quiet |
| **Stopped** | Gray (dim) | Session was stopped gracefully |
| **Dead** | Red | The CLI process exited |

State detection is passive — Tether watches output cadence; it does not parse or filter the terminal stream.

## Managing Sessions

### Renaming

Double-click the label in the sidebar, or right-click and choose **Rename**. Enter to confirm, Escape to cancel.

### Stopping

**Ctrl+W** sends a graceful stop signal (SIGTERM) to the active session. You can also right-click and choose **Stop**. If the session doesn't terminate within 3 seconds, Tether automatically escalates to a forced kill. Clicking **Stop** a second time during the grace period forces an immediate kill.

### Removing

Right-click and choose **Remove** to drop the session from the sidebar. If it's still running, it's stopped first.

### Duplicating

Right-click and choose **Duplicate** to clone a session with the same environment, working directory, profile, env vars, and flags. The label is preserved with a `(copy)` suffix (`(copy 2)` on subsequent dupes).

### Reordering

Drag sessions within a group to reorder them. Order is persisted per repo group.

### Muting notifications

Right-click a session and choose **Mute notifications** to silence desktop notifications for that session only — useful when one session is noisy but you still want alerts from others. Muted sessions show a 🔕 badge next to the status dot. Unmute from the same right-click menu. Global notification triggers are configured in [Settings](settings#notifications).

### Pane recovery

If a session inside a split pane dies, the pane shows an in-pane overlay with **Restart in this pane** (re-spawn with the same params, keeping the layout slot) or **Close pane**.

## Broadcast Input

When you have multiple panes open in a split layout, you can broadcast keystrokes to several sessions at once — useful for running the same command in parallel. Toggle broadcast targets from the pane status strip or from **Session → Clear Broadcast Input Targets** to reset. When broadcast is active, anything you type in the focused pane is echoed to all targeted panes simultaneously.

## Bulk Actions on a Group

Right-click a repo-group header in the sidebar for bulk actions across every session in that group:

- **Stop all** — gracefully stop every running session under this working directory (auto-escalates to forced kill after 3 seconds per session)
- **Restart all** — stop and re-spawn each session with its original params
- **Clear all** — stop and remove every session

## Helm (opt-in)

A session can be designated as a **Helm** parent that dispatches pre-briefed child sessions via the `tether-helm` MCP. Enable per-session from the right-click menu. Experimental and personal; see [Helm](helm).

## Session Grouping

Sessions are grouped by environment in the sidebar (Local, then each SSH host, then each Coder deployment). Within each environment they are further grouped by working directory. Groups are collapsible and reorderable.

## Workspace Persistence

Tether saves open sessions, sidebar order, and pane layout to `{userData}/data.json` when you close the app. On next launch your workspace is restored — same sessions, same positions, same active session. Writes are atomic (tmp file → fsync → rename) and survive AV / OneDrive transient locks via a short retry loop.
