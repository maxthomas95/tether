# Keyboard Shortcuts

All shortcuts below are the defaults. Every one is **remappable** in [Settings → Shortcuts](settings#shortcuts) — click a row, press a new chord, and it's saved. Reserved chords (e.g. **Ctrl+C** for copy / SIGINT) prompt for explicit confirmation before rebinding.

## Session Management

| Shortcut | Action |
|----------|--------|
| **Ctrl+N** | Create a new session |
| **Ctrl+P** | Find a session (quick switcher) |
| **Ctrl+W** | Stop the active session (SIGTERM) |

## Navigation

| Shortcut | Action |
|----------|--------|
| **Ctrl+1** through **Ctrl+9** | Switch to session by position |
| **Ctrl+ArrowDown** | Next session |
| **Ctrl+ArrowUp** | Previous session |

## Split Panes

| Shortcut | Action |
|----------|--------|
| **Alt+Arrow** | Focus the pane in that direction (un-maximizes if needed) |
| **Alt+Shift+Arrow** | Swap the focused pane with its neighbor |

## Zoom & Font

| Shortcut | Action |
|----------|--------|
| **Ctrl+scroll** on a terminal pane | Change terminal font size for that pane |
| **Ctrl+=** | Zoom whole window in (UI + terminal together) |
| **Ctrl+-** | Zoom whole window out |
| **Ctrl+0** | Reset window zoom |

Window zoom uses `webFrame.setZoomLevel`. Per-pane font size is persisted with the layout.

## Interface

| Shortcut | Action |
|----------|--------|
| **Ctrl+B** | Toggle sidebar visibility |
| **Ctrl+,** | Open Settings |
| **Ctrl+/** | Show this Keyboard Shortcuts dialog |

## Terminal

All other keyboard input is passed directly to the active terminal session. Tether does not intercept or modify terminal keystrokes — what you type goes straight to the selected CLI. This includes **Ctrl+C** (SIGINT), Ctrl-clicking printed URLs (which Tether opens via `shell.openExternal`), and the CLI's own bindings.
