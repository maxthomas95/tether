# Sessions

## Check and update a session's CLI

Choose **Check / update CLI…** from a Codex, Claude Code, or OpenCode session's menu.
The maintenance terminal uses that session's machine or Coder workspace and its
launch environment. Check the executable path and version before updating, and
choose the update method matching your installation. Existing conversations keep
running; restart or resume them when ready after an update. See **Settings → CLI
updates** for installation methods and cancellation behavior.

A **session** in Tether is a running CLI process in a specific directory and environment. You can have many sessions open at once, each with its own terminal. Tether is a "dumb pipe" — the PTY stream flows byte-for-byte into the terminal; nothing is parsed, rewritten, or intercepted.

The optional **[Pip sidebar pet](settings.md#pip-sidebar-pet)** follows the focused session, reacts to its status, and taps a tiny keyboard while you type. Enable it from **View → Pip Sidebar Pet**. Its **waiting** button opens another session that needs input, with permission prompts first. Optional AI quips and submitted-prompt sharing have separate switches in Pip's **Personality & comments** controls.

## Creating Sessions

On Windows, npm-installed CLI tools use their Windows command shim (for example,
`codex.cmd`), even when npm also installs an extensionless Unix script beside it.

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

If workspace initialization fails, Tether reports the error and keeps the saved
workspace intact. Restart Tether to retry before relying on workspace saving.
Stopping a session cancels its conversation-ID watcher immediately. A transcript
read failure ends that watcher without interrupting the running CLI.

For local Claude Code, Codex CLI, GitHub Copilot CLI, and OpenCode sessions, use **Resume conversation** in the launcher to choose history for the working directory. Tether uses `claude --resume <id>`, `codex resume <id>`, `copilot --resume <id>`, or `opencode --session <id>`. The conversation picker is local-only.

For Claude Code and Codex CLI over **SSH or Coder**, **Restart in this pane** and **Restart all** resume the exact conversation when Tether knows its native session ID. Workspace restore also uses that ID when **Resume previous conversations** is enabled. Claude's ID is assigned at launch; Codex's ID is captured by the passive remote usage connection, independently of status hooks. Tether never chooses the most recent conversation in the directory, so another session in the same repo cannot change which conversation is resumed.

Recovery requires the same remote host or Coder workspace, CLI user/home, and saved conversation history. If Claude Code has no history for the saved ID (the pane closed before its first message, the conversation was switched with `/resume` or `/clear`, or the history was deleted), the pane opens a fresh Claude conversation under that same ID instead of stopping on a resume error; use `/resume` inside Claude to reopen another conversation. Codex CLI still reports its own resume error. If Tether never captured an ID (for example, remote Codex usage collection was unavailable before disconnection), restarting opens a fresh session and you can use the CLI's own resume picker to recover older history. Resuming restores saved conversation context; it does not reattach a surviving process or keep a task running through disconnection.

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
| **Running** | Green | The CLI is working, including model calls, tools and tracked subagents |
| **Waiting** | Amber | The CLI is paused on a prompt (input, permission, tool approval) |
| **Idle** | Gray | Session is alive but quiet |
| **Stopped** | Gray (dim) | Session was stopped gracefully |
| **Dead** | Red | The process exited with an error, or the transport failed |

State detection is passive — Tether watches output cadence; it does not parse or filter the terminal stream. With [CLI hooks](settings.md#cli-hooks) enabled, Claude/Codex sessions get hook-grade detection on top: local sessions automatically, SSH sessions when their environment opts in via [CLI status hooks on remote hosts](environments.md#cli-status-hooks-on-remote-hosts). Coder sessions are cadence-only for now.

Hook-confirmed completion and permission waits survive terminal redraws, typing
echo and window resizing. Claude stays running while tracked subagents are
active, including when the parent pauses for their results. Answering an
elicitation resumes work; it does not mean the turn has finished.

When hooks are unavailable, detection estimates activity from output and silence.
It cannot reliably distinguish a quiet model or remote subagent from an idle
prompt. A user-owned Codex `notify` command is preserved; without Tether's notify
or opted-in lifecycle hooks, that session uses these estimates too.

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

Windows local and Coder sessions use the bundled terminal backend so **Stop** works with the packaged app's security hardening enabled.

### Removing

Right-click and choose **Remove** to drop the session from the sidebar. If it's still running, it's stopped first.

### Duplicating

Right-click and choose **Duplicate** to clone a session with the same environment, working directory, profile, env vars, and flags. The label is preserved with a `(copy)` suffix (`(copy 2)` on subsequent dupes).

The duplicate starts independently of the original. You can remove the original
while an SSH connection is starting; the duplicate opens in the current layout
when it is ready, even if the original pane has been removed or you switched to
Canvas while waiting.

Duplicate keeps the selected launch profile and the session-specific environment and CLI flag overrides from the original session. Global defaults, environment variables from the selected environment, and the profile's current contents are read again at launch, so later Settings changes still apply. Vault references are resolved fresh. If the saved profile was deleted, or the OS keychain cannot read the saved launch settings, Tether stops before starting a process instead of launching with different defaults.

### Reordering

Drag sessions within a group to reorder them. Order is persisted per repo group.

### Muting notifications

Right-click a session and choose **Mute notifications** to silence desktop notifications and generic outbound webhooks for that session. Muted sessions show a 🔕 badge next to the status dot. Unmute from the same menu. Global triggers are configured in [Settings](settings.md#notifications).

### Pane recovery

If a session inside a split pane dies, the pane shows an in-pane overlay with **Restart in this pane** (re-spawn with the same working directory, environment, launch profile, session overrides, and known conversation, keeping the layout slot) or **Close pane**.

## Broadcast Input

Broadcast input is available in split layouts. Entering Canvas clears broadcast targets; typing in Canvas goes to the focused terminal.

Toggle broadcast targets from each pane header. With at least two live targets selected, input from a selected pane is sent to every selected session. Input from an unselected pane stays in that pane. Dead or stopped sessions are removed from the targets. Use **Session → Clear Broadcast Input Targets** to reset.

## Finding Text in a Terminal

Press **Ctrl+Shift+F**, choose **Session → Find in Terminal**, or click the find button in a pane header to search the focused terminal's scrollback. The search bar stays inside that pane, works in single, split, and Canvas layouts, and searches the existing xterm buffer without sending anything to the CLI.

- Type to search incrementally
- **Enter** jumps to the next match
- **Shift+Enter** jumps to the previous match
- **Aa** toggles match case
- **W** toggles whole-word matching
- **Esc** closes the bar, clears search highlights, and returns focus to the terminal

## Bulk Actions on a Group

Right-click a repo-group header in the sidebar for bulk actions across every session in that group:

- **Stop all** — gracefully stop every running session under this working directory (auto-escalates to forced kill after 3 seconds per session)
- **Restart all** — stop and re-spawn each session with its original params, resuming its known conversation
- **Clear all** — stop and remove every session

## Helm (opt-in)

A session can be designated as a **Helm** parent that dispatches pre-briefed child sessions via the `tether-helm` MCP. Enable per-session from the right-click menu. Experimental and personal; see [Helm](helm.md).

## Session Grouping

Sessions are grouped by environment in the sidebar (Local, then each SSH host, then each Coder deployment). Within each environment they are further grouped by working directory. Groups are collapsible and reorderable.

For **local** repo groups, the header also shows the current git branch and, if there are uncommitted changes, a dot with the count (e.g. `main ●2`). This refreshes when the window regains focus and periodically in the background. Not shown for SSH or Coder groups.

## Subagents

When a **Claude Code** session starts subagents (local, SSH or Coder), a **subagents** line appears under it in the sidebar. Click the line (or press **Enter** or **Space** on it) to open or close the list. Each row is one subagent, indented under the subagent that started it:

`↳ code-reviewer · Check the diff` on the first line, then `sonnet-5-5/medium · running 2m · 12.3k tok` below it.

- **Status dot** — green while the subagent is running, gray once it has finished.
- **Model and effort** — the model that actually answered, with the reasoning effort when Claude records one. If the subagent has not answered yet, the model the parent requested is shown instead. Nothing is shown when neither is known.
- **Timing** — `running 2m` counts up from the start; `done 41s` is how long it worked.
- **Tokens** — input, output and newly cached tokens the subagent used. Cache reads are left out of the total because they repeat every turn; hover a row for the full breakdown.
- At most 20 rows show. Finished subagents drop off first, so a running one is never hidden. **+N more** shows the rest, and Tether keeps the 50 most recent subagents of a session.

Click a row to read what the subagent did. The viewer is read-only, because subagents have no terminal of their own: it shows the task it was given, a compact list of its messages and tool calls (tool output is not shown), and its final answer. For a very long run it shows the task from the start and only the most recent activity, and says so. It refreshes while the subagent runs, reading only what was added. **Escape** closes it.

Tether reads the files Claude Code writes for each subagent; it does not look at the terminal. A subagent counts as running when [CLI hooks](settings.md#cli-hooks) report that it has started and not stopped. With hooks off, or before the first hook event arrives, it counts as running while its transcript has changed in the last 30 seconds, so a subagent that thinks quietly for longer can show as done. Tether checks for new subagents every few seconds while one is running or the list is open. With hooks off it also looks about every ten seconds, but only if Claude's folder for the session sits where Tether expects it; if Tether has to search for that folder (very long working-directory paths), it searches less and less often, up to about every three minutes, until a subagent hook event or a restart.

**SSH and Coder sessions** work the same way, with the files read on the remote host. Remote hooks are available for SSH environments that opt in ([CLI status hooks on remote hosts](environments.md#cli-status-hooks-on-remote-hosts)); Coder sessions have no hooks yet, so their subagents use the 30-second rule. Remote reads reuse the same kind of background reader as [remote usage collection](usage-quota.md#ssh-and-coder-sessions): one reader process per SSH host or Coder workspace, started once and shared by every session there, so an elevated (**sudo**) SSH host authenticates once rather than on every check. Each check is a short request to that process, never a new login, and the process stays open for as long as any live session uses that host. Checks fetch only metadata (token counts, models, timing), not message text; the full transcript is fetched only when you open a subagent. The reader needs `node` on the remote login-shell PATH, and at most the 50 newest subagents of a session are read. If the reader cannot start, the rows stay empty and Tether waits progressively longer (up to 10 minutes) before trying again; the terminal is never affected. Opening a subagent downloads its transcript the way a local one is read: a long one is fetched as its first lines (the task) plus its last 8 MB, then only what is appended. Searching the remote host for the session's folder backs off the same way as locally.

Subagent rows are not shown for other CLIs. Turn them off in [Settings → Appearance](settings.md#show-subagents-in-sidebar).

## Finding a Session

Press **Ctrl+P** (or **Session → Find Session…**) to open the quick switcher — a VS Code-style finder for jumping straight to any session without scrolling the sidebar. Start typing to fuzzy-match across the session label, working directory, environment name, and CLI tool. Matching is forgiving: the characters you type just have to appear in order, so `apsv` finds *api-server*. Results rank label hits above directory hits, contiguous matches above scattered ones, and start-of-word matches above mid-word ones.

- **↑ / ↓** move the highlight
- **Enter** opens the highlighted session
- **Esc** closes the switcher
- Clicking a row opens it too

Opening a session from the switcher behaves exactly like clicking it in the sidebar: if it's already mounted in a pane, that pane is focused (and un-maximized if it was hidden behind a maximized pane); otherwise it replaces the focused/empty pane in a standard layout or adds a panel in Canvas.

Switching sessions preserves the background session's terminal buffer. Pending layout work from the previous session is discarded so only the current session receives focus and terminal-size updates.

Terminals refit when you resize a pane or the Tether window, including after maximizing or restoring. The new row and column counts are sent to Local, SSH, and Coder sessions. Hidden panes retain their last usable terminal size until visible again. Coder's Windows CLI may take about a second to forward a size change to the workspace.

## Attention queue

With several sessions running at once, "which one needs me?" is the recurring question. The attention queue answers it: press **Ctrl+Shift+A** (or click **Session → Jump to Next Waiting**, or the amber **N waiting** pill beside **Settings** at the bottom of the sidebar) to jump straight to the next session that's amber — **Waiting** — sorted permission prompts first, then oldest-waiting first. Repeated presses cycle through the whole queue, wrapping back to the start once you've seen them all, so it doubles as a "drain the queue" loop across a busy sidebar.

The pill only appears when at least one session is waiting, and shows the live count. It shares the existing Settings row, so appearing or disappearing does not move session rows or their action menus. Muting suppresses desktop notifications and generic webhooks, but leaves the session in the attention queue.

The shortcut is remappable like any other; see [Keyboard Shortcuts](keyboard-shortcuts.md).

Hover any session row for about a third of a second and a small popover shows its last few terminal lines — a quick way to triage which session actually needs you before you switch to it. It works for any session with terminal output, not just waiting ones, and pairs naturally with the attention queue for draining a busy sidebar.

## Workspace Persistence

Tether saves open sessions and their order to `{userData}/data.json` as the workspace changes. Writes are atomic (tmp file → fsync → rename) and survive AV / OneDrive transient locks via a short retry loop. On next launch, saved sessions reopen when **Restore sessions on launch** is enabled.

Workspace restore keeps an opaque reference to the encrypted launch settings for each saved session. It restores the selected launch profile and any session-specific environment variables, CLI flags, and disabled inherited flags. Global defaults, environment settings, and the profile's current values are still read from current configuration, and Vault references are resolved again during launch. Older workspace entries without saved launch settings reopen with their existing metadata-only behavior.

Entries that fail to restore remain saved for the next launch, even while other sessions open or close. The error notification offers **Forget failed sessions**; confirming removes those entries from the saved workspace. Dismissing the notification keeps them saved.

### Workspace recipes

Choose **File ? Workspaces?** to save the current set of sessions as a workspace recipe. A recipe stores the session labels, working directories or Coder workspace names, environment targets, CLI tools, Helm setting, and layout shape. It does not store terminal output, native conversation ids, or running process state.

Opening a recipe starts fresh normal CLI sessions and keeps your current sessions running. Before opening, you can select which recipe slots to start, edit each working directory, and remap each slot to Local PC, a known SSH environment, or a known Coder environment. If a saved environment was deleted, Tether shows it as missing until you choose another target.

Recipe launches validate every selected slot before any process starts. If some sessions start and another fails or you cancel the remaining work, the dialog marks started slots and lets you start only the remaining selected slots without duplicating the successful ones. **Show started sessions** switches to the sessions that did start and applies the saved layout. Closing instead leaves any already-created sessions in the sidebar without changing focus or layout.

Recipes use the same launch path as creating sessions manually. Manual CLI flags, disabled inherited flags, launch profiles, current environment defaults, and Vault references still apply at the next launch. Vault references are resolved fresh. Recipes do not stop sessions, create git worktrees, import or export files, or auto-start on app launch.

### Canvas workspace

Select **Layout → Canvas** or **View → Canvas Mode** to use movable, resizable session panels. Canvas is independent of the split-pane setting and its four-pane limit.

- On first use, existing sessions are placed on the canvas. Click a session in the sidebar or use **Add session** to open another panel. Selecting a session already on the canvas brings its panel into view and focuses it.
- Drag a sidebar session onto the canvas to place it at the drop position. Drag panel headers to move them and panel edges or corners to resize them.
- Click inside a terminal to type. Selecting text and scrolling terminal history keep their normal behavior; drag empty canvas space to pan.
- **Arrange panels** resizes and places all canvas panels in a grid. Panels keep a minimum usable size, so large workspaces can extend below the visible area.
- Maximize a panel with its header button or a double-click on the header. Restore returns to its previous size and location.
- **Close pane** removes the panel from the canvas and leaves its session running in the sidebar. Session stop/remove actions still control the process.
- Returning to a single or split layout keeps the canvas arrangement for later. Panel positions, sizes, stacking order, focus, and canvas position are saved with the workspace and remapped to restored sessions on launch. The selected layout mode is remembered. Restoring sessions on launch must be enabled to reopen them after quitting.

Offscreen panels detach their terminal views while their sessions keep running. Bringing a panel back into view reuses its terminal buffer. Canvas does not change the terminal stream or the behavior of Local, SSH, or Coder transports.
