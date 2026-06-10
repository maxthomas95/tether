# Getting Started

Tether is a desktop session multiplexer for Claude Code, Codex CLI, OpenCode, and any custom shell binary. It gives you one window to drive many agent sessions across local, SSH, and Coder workspace environments — preserving the exact native terminal experience by piping the raw PTY straight into xterm.js.

## First Launch

The Setup Wizard runs on first launch and walks you through:

1. **Repos root** — a parent directory Tether uses when cloning new projects and creating folders. You can change this later from **New Session**.
2. **Vault** — optional HashiCorp Vault configuration, login, and plaintext-secret migration.
3. **Environment and CLI** — Local is ready automatically; you can also add SSH or Coder and choose the default CLI tool for new sessions.
4. **Git provider** — optional GitHub, Azure DevOps, or Gitea credentials for repo browse, clone, and remote-create.

The wizard only marks setup complete when you click **Skip Setup**, **Start Using Tether**, or **Create First Session**. Closing it with **Esc** or **X** just dismisses it for this app run.

## Creating Your First Session

1. Click **+ New session** in the sidebar, or press **Ctrl+N**
2. Choose how to start:
   - **Existing folder** — browse to or paste a working directory. If it's a git repo, you can optionally create a **git worktree** for the session (see [Sessions](sessions#git-worktrees-local-only)).
   - **Clone** — clone a repo from GitHub / Azure DevOps / Gitea (see [Git Providers](git-providers))
   - **New folder** — create an empty folder under your repos root, optionally `git init` and provision an empty remote (see [Git Providers](git-providers#new-folder))
3. Pick an [environment](environments) (Local, SSH, or Coder)
4. Pick a CLI tool (Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, or a custom binary)
5. Optionally set a label, [launch profile](settings#launch-profiles), env vars, or CLI flags
6. Click **Create**

The session launches in a new pane and the CLI takes over from there.

## The Interface

### Sidebar

The left sidebar groups sessions by environment and then by working directory. Each session row shows:

- A **status dot** — green (running), amber (waiting on you), gray (idle), red (dead / stopped)
- The **label** (auto-named from the directory, or rename inline by double-clicking)
- A **pane badge** when the session is currently mounted in a split pane
- A **🔕 badge** when notifications are muted for that session
- A **↻ badge** when the session was resumed from a previous conversation (optional — see [Settings](settings#session-restore))

Drag sessions to reorder them inside a group. Right-click a group header for **bulk actions** (Stop all, Restart all, Clear all). Right-click a session for per-session actions (Stop, Duplicate, Remove, Mute/Unmute notifications, Helm enable). Collapse groups with the chevron. Resize the sidebar by dragging its edge (180–400px) or hide it with **Ctrl+B**.

Footers along the bottom of the sidebar show:

- [Vault](vault) auth and expiry status
- Today's [cost and 7-day usage sparkline](usage-quota#global-usage-footer)
- [Subscription quota](usage-quota#quota-tracking) status (if you've enabled it)

### Terminal Panel

The main area displays the active session. It's a real terminal emulator (xterm.js — the same one VS Code uses). Output flows through byte-for-byte; Tether does not parse or rewrite what the CLI prints. State detection is a passive side-channel.

- Click a session in the sidebar to switch to it
- **Ctrl+1** through **Ctrl+9** — switch by position
- **Ctrl+ArrowDown** / **Ctrl+ArrowUp** — next / previous session
- **Ctrl+scroll** on the terminal — change terminal font size
- **Ctrl+=** / **Ctrl+-** — zoom the whole window (UI + terminal together)
- **Ctrl-click** any printed URL — opens in your system browser

### Split Panes

Drag a session from the sidebar onto the edge of the terminal area to view two or more side-by-side. Drop zones light up as you drag:

- **Left / Right** — horizontal split
- **Top / Bottom** — vertical split
- **Center** — replace the current pane

Once split, use **Alt+Arrow** to focus the neighboring pane (un-maximizing if needed) and **Alt+Shift+Arrow** to swap the focused pane's session with its neighbor. If a session inside a pane dies, an in-pane overlay offers **Restart in this pane** or **Close pane** so the layout survives.

You can also **broadcast input** to multiple panes at once — toggle targets from the pane status strip. See [Sessions](sessions#broadcast-input).

### Desktop Notifications

Tether can post OS notifications when a session goes waiting, idle, or exits. Configure triggers in [Settings](settings#notifications), and mute individual sessions from their right-click menu.

## Next Steps

- [Sessions](sessions) — lifecycle, states, multi-CLI, bulk actions
- [Environments](environments) — Local / SSH / Coder setup
- [Git Providers](git-providers) — GitHub / Azure DevOps / Gitea cloning and remote-create
- [Vault](vault) — HashiCorp Vault for secrets
- [Usage & Quota](usage-quota) — cost tracking, history, subscription quota
- [Helm](helm) — opt-in MCP dispatcher (experimental)
- [Keyboard Shortcuts](keyboard-shortcuts) — full shortcut reference (now user-remappable)
- [Settings](settings) — themes, env vars, CLI flags, keybindings, integrations
