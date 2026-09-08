# Keyboard Shortcuts

The title bar's **Find session** button opens the session switcher and displays its current shortcut, including custom bindings. Session rows also support **Shift+F10** for their action menu; use arrow keys to move and **Escape** to dismiss it.

The app-action shortcuts below are defaults and are **remappable** in [Settings → Shortcuts](settings.md#shortcuts). Click a row, press a new chord, and it saves immediately. Reserved chords (e.g. **Ctrl+C** for copy / SIGINT) prompt for confirmation before rebinding. Clipboard shortcuts, **Shift+F10**, and mouse gestures such as **Ctrl+scroll** and **Ctrl+click** are not entries in that editor.

## Session Management

| Shortcut | Action |
|----------|--------|
| **Ctrl+N** | Create a new session |
| **Ctrl+P** | Find a session (quick switcher) |
| **Ctrl+W** | Stop the active session |

## Navigation

| Shortcut | Action |
|----------|--------|
| **Ctrl+1** through **Ctrl+9** | Switch to session by position |
| **Ctrl+Shift+A** | Jump to next waiting session (see [Attention queue](sessions.md#attention-queue)) |

## Split Panes

| Shortcut | Action |
|----------|--------|
| **Alt+Arrow** | Focus the pane in that direction (un-maximizes if needed) |
| **Ctrl+ArrowDown** / **Ctrl+ArrowUp** | Focus the next / previous pane in layout order |
| **Alt+Shift+Arrow** | Swap the focused pane with its neighbor |

## Zoom & Font

| Shortcut | Action |
|----------|--------|
| **Ctrl+scroll** on a terminal pane | Change terminal font size for that pane |
| **Ctrl+=** | Zoom whole window in (UI + terminal together) |
| **Ctrl+-** | Zoom whole window out |
| **Ctrl+0** | Reset window zoom |

Window zoom affects the whole app. **Ctrl+scroll** sets a font-size override for that session's lifetime. Clear overrides with **Settings → Terminal → Reset all session font sizes**; **Ctrl+0** only resets window zoom.

## Interface

| Shortcut | Action |
|----------|--------|
| **Ctrl+B** | Toggle sidebar visibility |
| **Ctrl+,** | Open Settings |
| **Ctrl+/** | Show this Keyboard Shortcuts dialog |

## Terminal

Most keyboard input is passed straight to the active session — Tether does not intercept or modify terminal keystrokes, so the CLI's own bindings all work. A handful of clipboard shortcuts are handled by Tether:

| Shortcut | Action |
|----------|--------|
| **Ctrl+C** | Copy the selection if there is one; otherwise passes through as **SIGINT** |
| **Ctrl+Shift+C** | Always copy the selection |
| **Ctrl+V** | Paste. Uses bracketed paste when the app requests it, so a multi-line paste into Claude Code's input arrives as one block instead of a burst of submits |
| **Ctrl+click** a printed URL | Open it in your browser (via `shell.openExternal`) |

### Selecting text in full-screen apps

Claude Code's full-screen rendering (`/tui fullscreen`, or `CLAUDE_CODE_NO_FLICKER=1`) — like other full-screen TUIs such as vim or htop — turns on **mouse reporting**. That hands your click-and-drag to the app instead of selecting text, so ordinary drag-to-select stops working. To select text natively, **hold Shift while you drag**: that bypasses the app's mouse capture and lets Tether's terminal make the selection, and **Ctrl+C** / **Ctrl+Shift+C** then copy it.

This matters most over **SSH and Coder**, where the remote CLI can't reach your local clipboard on its own. When a CLI copies to the clipboard itself — Claude Code does this over SSH using the OSC 52 escape sequence — Tether forwards it to your local clipboard automatically, so a copy inside the remote session lands on your local machine. (For safety, this is one-way: remote apps can write your clipboard, never read it.)
