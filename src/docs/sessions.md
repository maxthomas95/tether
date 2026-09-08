# Sessions

A **session** in Tether is a running CLI process in a specific directory and environment. You can have many sessions open at once, each with its own terminal. Tether is a "dumb pipe" — the PTY stream flows byte-for-byte into the terminal; nothing is parsed, rewritten, or intercepted.

## Creating Sessions

Click **+ New session** or press **Ctrl+N**. The dialog has three tabs for picking a working directory:

- **Existing directory** — browse to or paste a path you already use
- **Clone** — clone a remote repo via a configured Git provider (see [Git Providers](git-providers.md))
- **New folder** — create an empty folder under your repos root, optionally `git init` and provision an empty remote (see [Git Providers](git-providers.md#new-folder)). New folder mode is local-only.

On Existing directory and New folder, pressing **Enter** in a standard text field runs the same primary action as clicking **Create session**.

Other fields:

- **Environment** — Local, SSH, or Coder (see [Environments](environments.md))
- **CLI tool** — [Claude Code](#multi-cli-support), [Codex CLI](#multi-cli-support), [GitHub Copilot CLI](#multi-cli-support), [OpenCode](#multi-cli-support), or a [Custom](#multi-cli-support) binary
- **Label** — optional display name (defaults to the directory name)
- **Launch profile** — preset env vars and CLI flags (see [Settings](settings.md#launch-profiles))
- **Environment variables** — key-value pairs passed to the CLI process. Values can be `vault://` references; see [Vault](vault.md).
- **CLI flags** — additional command-line arguments. Multi-token flags like `--permission-mode plan` are tokenized at the transport boundary.

### Resume from the launcher

On **Existing directory**, choose a local directory and a CLI with conversation history, then click **Resume conversation**. Pick a conversation to launch a session that resumes it with the selected profile and flags. Escape closes the picker and returns to the launch form. Resume is unavailable for SSH, Coder, Custom tools, or while creating a new worktree, and respects the conversation-resume setting.

### Git worktrees (local only)

When the Existing directory tab points to a git repository, a **Create as new git worktree** checkbox appears. Check it, type a branch name, and Tether will `git worktree add` a new working tree alongside the repo before spawning the session. The worktree path auto-fills from the branch name but can be edited. Useful for running parallel agent sessions on different branches of the same repo without juggling stashes or clones.

Local Git operations require a full, absolute directory path. Spaces and Unicode names are supported. Worktree branch names must be valid Git branch names; values that look like command options are rejected.

Install Git in an absolute directory listed on your system PATH. Tether's Git operations skip relative PATH entries and do not search the project folder for Git. On Windows, they use `git.exe` directly; batch-file wrappers are not supported for these operations.

## Resume Conversation

For local Claude Code, Codex CLI, GitHub Copilot CLI, and OpenCode sessions, use **Resume conversation** in the launcher to choose history for the working directory. Tether uses `claude --resume <id>`, `codex resume <id>`, `copilot --resume <id>`, or `opencode --session <id>`. Tether's conversation picker and automatic resume are unavailable for SSH, Coder, and Custom sessions.

Claude Code and GitHub Copilot transcript lookups require a full session UUID. Invalid identifiers are treated as unavailable conversations and are not used as filesystem paths.

## Multi-CLI Support

Tether is CLI-agnostic. The CLI registry lives in `src/shared/cli-tools.ts`; per-CLI quirks (resume args, default flags, transcript reader) are kept there rather than scattered through transports.

| Tool | Notes |
|------|-------|
| **Claude Code** | Full integration: resume (`--resume`, `--session-id`), transcript browsing, hooks-based status detection. |
| **Codex CLI** | Full integration: `codex resume <id>`, transcript browsing, session-id watcher captures `sessionId` at spawn, hooks-based status detection. |
| **GitHub Copilot CLI** | Resume support, transcript browsing. |
| **OpenCode** | Resume (`--session <id>`) and transcript browsing. Cost coverage depends on the supported local database; see [Usage & Quota](usage-quota.md#how-it-works). |
| **Custom** | Any binary you specify. No resume, no transcript reader. |

## Session States

Each session has a state, shown by the colored dot in the sidebar:

| State | Color | Meaning |
|-------|-------|---------|
| **Running** | Green | The CLI is actively generating output |
| **Waiting** | Amber | The CLI is paused on a prompt (input, permission, tool approval) |
| **Idle** | Gray | Session is alive but quiet |
| **Stopped** | Gray (dim) | Session was stopped gracefully |
| **Dead** | Red | The process exited with an error, or the transport failed |

State detection is passive — Tether watches output cadence; it does not parse or filter the terminal stream. With [CLI hooks](settings.md#cli-hooks) enabled, Claude/Codex sessions get hook-grade detection on top: local sessions automatically, SSH sessions when their environment opts in via [CLI status hooks on remote hosts](environments.md#cli-status-hooks-on-remote-hosts). Coder sessions are cadence-only for now.

Claude and Codex panes can show [usage totals from SSH and Coder hosts](usage-quota.md#ssh-and-coder-sessions)
even when status hooks are off. Collection uses a separate connection and leaves
the terminal stream untouched. **Waiting for remote usage** means the transcript
has not been identified yet; **Last collected** means collection is temporarily
unavailable and the displayed totals may be stale.

## Managing Sessions

Each session has a visible **Actions** (…) button; the same actions remain available by right-click. With a session row focused, **Shift+F10** opens its menu. Use arrow keys to move through actions and **Escape** to close it.

Pane headers show the environment alongside the session label, including when the sidebar is hidden. The broadcast, maximize/restore, and close buttons remain visible. A placeholder pane's **Choose a session** action opens the session switcher.

### Renaming

Double-click the label in the sidebar, or right-click and choose **Rename**. Enter to confirm, Escape to cancel.

### Stopping

**Ctrl+W** or **Stop** requests shutdown of the active session. Local and Coder sessions terminate their local PTY process; SSH sends **Ctrl+C**, then `exit`, and closes the connection. If the session remains alive, Tether escalates after the 3-second grace period. A second **Stop** during that period forces an immediate kill.

### Removing

Right-click and choose **Remove** to drop the session from the sidebar. If it's still running, it's stopped first.

### Duplicating

Right-click and choose **Duplicate** to clone a session with the same environment, working directory, profile, env vars, and flags. The label is preserved with a `(copy)` suffix (`(copy 2)` on subsequent dupes).

### Reordering

Drag sessions within a group to reorder them. Order is persisted per repo group.

### Muting notifications

Right-click a session and choose **Mute notifications** to silence desktop notifications and generic outbound webhooks for that session. Muted sessions show a 🔕 badge next to the status dot. Unmute from the same menu. Global triggers are configured in [Settings](settings.md#notifications).

### Pane recovery

If a session inside a split pane dies, the pane shows an in-pane overlay with **Restart in this pane** (re-spawn with the same params, keeping the layout slot) or **Close pane**.

## Broadcast Input

Toggle broadcast targets from each pane header. With at least two live targets selected, input from a selected pane is sent to every selected session. Input from an unselected pane stays in that pane. Dead or stopped sessions are removed from the targets. Use **Session → Clear Broadcast Input Targets** to reset.

## Bulk Actions on a Group

Right-click a repo-group header in the sidebar for bulk actions across every session in that group:

- **Stop all** — gracefully stop every running session under this working directory (auto-escalates to forced kill after 3 seconds per session)
- **Restart all** — stop and re-spawn each session with its original params
- **Clear all** — stop and remove every session

## Helm (opt-in)

A session can be designated as a **Helm** parent that dispatches pre-briefed child sessions via the `tether-helm` MCP. Enable per-session from the right-click menu. Experimental and personal; see [Helm](helm.md).

## Session Grouping

Sessions are grouped by environment in the sidebar (Local, then each SSH host, then each Coder deployment). Within each environment they are further grouped by working directory. Groups are collapsible and reorderable.

For **local** repo groups, the header also shows the current git branch and, if there are uncommitted changes, a dot with the count (e.g. `main ●2`). This refreshes when the window regains focus and periodically in the background. Not shown for SSH or Coder groups.

## Finding a Session

Press **Ctrl+P** (or **Session → Find Session…**) to open the quick switcher — a VS Code-style finder for jumping straight to any session without scrolling the sidebar. Start typing to fuzzy-match across the session label, working directory, environment name, and CLI tool. Matching is forgiving: the characters you type just have to appear in order, so `apsv` finds *api-server*. Results rank label hits above directory hits, contiguous matches above scattered ones, and start-of-word matches above mid-word ones.

- **↑ / ↓** move the highlight
- **Enter** opens the highlighted session
- **Esc** closes the switcher
- Clicking a row opens it too

Opening a session from the switcher behaves exactly like clicking it in the sidebar: if it's already mounted in a pane, that pane is focused (and un-maximized if it was hidden behind a maximized pane); otherwise it replaces the focused/empty pane.

## Attention queue

With several sessions running at once, "which one needs me?" is the recurring question. The attention queue answers it: press **Ctrl+Shift+A** (or click **Session → Jump to Next Waiting**, or the amber **N waiting** pill in the sidebar header) to jump straight to the next session that's amber — **Waiting** — sorted permission prompts first, then oldest-waiting first. Repeated presses cycle through the whole queue, wrapping back to the start once you've seen them all, so it doubles as a "drain the queue" loop across a busy sidebar.

The pill only appears when at least one session is waiting, and shows the live count. Muting suppresses desktop notifications and generic webhooks, but leaves the session in the attention queue.

The shortcut is remappable like any other; see [Keyboard Shortcuts](keyboard-shortcuts.md).

Hover any session row for about a third of a second and a small popover shows its last few terminal lines — a quick way to triage which session actually needs you before you switch to it. It works for any session with terminal output, not just waiting ones, and pairs naturally with the attention queue for draining a busy sidebar.

## Workspace Persistence

Tether saves open sessions, sidebar order, and pane layout to `{userData}/data.json` when you close the app. On next launch your workspace is restored — same sessions, same positions, same active session. Writes are atomic (tmp file → fsync → rename) and survive AV / OneDrive transient locks via a short retry loop.
