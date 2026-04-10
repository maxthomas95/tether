# Getting Started

Tether is a desktop session multiplexer for Claude Code. It provides a single unified interface to manage multiple Claude Code sessions across local, SSH, and containerized environments -- preserving the exact native terminal experience.

## First Launch

When you first open Tether, you'll see the sidebar on the left and an empty terminal area on the right. A default "Local" environment is created automatically for running sessions on your machine.

## Creating Your First Session

1. Click **+ New session** in the sidebar, or press **Ctrl+N**
2. Select an environment (Local is the default)
3. Choose a working directory -- this is where Claude Code will start
4. Optionally set a label, environment variables, or CLI flags
5. Click **Create**

The session will launch and you'll see the Claude Code terminal appear in the main panel.

## The Interface

### Sidebar

The left sidebar shows all your sessions, grouped by environment. Each session displays:

- A **status dot** indicating its current state (green = running, amber = waiting for input, gray = idle, red = dead)
- The session **label** (auto-generated from the directory name, or custom)
- The **working directory**

You can collapse environment groups, resize the sidebar by dragging its edge (180-400px), or hide it entirely with **Ctrl+B**.

### Terminal Panel

The main area displays the active session's terminal. This is a real terminal emulator (xterm.js) -- the same one used by VS Code. Claude Code's output flows through byte-for-byte, untouched. What you see is exactly what Claude Code produces.

Click a session in the sidebar to switch to it. You can also use **Ctrl+1** through **Ctrl+9** to switch by position, or **Ctrl+ArrowUp/Down** to move between sessions.

### Split Panes

You can view multiple sessions side-by-side by dragging a session from the sidebar and dropping it onto the edge of the terminal area. Drop zones appear as you drag:

- **Left/Right** -- creates a horizontal split
- **Top/Bottom** -- creates a vertical split
- **Center** -- replaces the current pane

To remove a split, close or move the session out of the pane.

## Next Steps

- [Sessions](sessions) -- learn about session lifecycle, states, and management
- [Environments](environments) -- set up SSH and remote environments
- [Keyboard Shortcuts](keyboard-shortcuts) -- full shortcut reference
- [Settings](settings) -- configure themes, environment variables, and CLI flags
