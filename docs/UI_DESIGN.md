# UI Design — Tether

> **Note:** This document was the original UI design spec. The implementation has evolved beyond this spec in several areas — notably session grouping (by working directory), the settings UI (dialog instead of panel), theming (5 Catppuccin themes + Default Dark), the New Session dialog (env selection, repo quick-pick, env vars, CLI flags, launch profiles, Coder workspace creation), pane splitting with snap layouts, the sidebar's Vault status pill and quota/usage footers, the per-session cost strip below each pane, the Resume Chat picker for Claude/Codex transcripts, and the Setup Wizard for first-run onboarding. Differences are noted inline.

## Layout

The application uses a simple two-column layout that puts the terminal front and center. The sidebar is the navigation layer; the terminal panel is where work happens.

```
┌───────────────────────────────────────────────────────────────────┐
│  Tether                                          ─  □  ✕   │
├──────────────┬────────────────────────────────────────────────────┤
│              │ ┌────────────────────────────────────────────────┐ │
│  [Sidebar]   │ │ NKP OIDC fix · ~/repos/nkp · sonnet-4        │ │
│              │ ├────────────────────────────────────────────────┤ │
│  + New       │ │                                                │ │
│              │ │  Claude Code native terminal                   │ │
│  ● NKP OIDC  │ │                                                │ │
│  ◉ VoidCode  │ │  (xterm.js — full PTY stream)                 │ │
│  ○ uChat PR  │ │                                                │ │
│  ○ Homelab   │ │                                                │ │
│  ◌ NetBox    │ │                                                │ │
│              │ │                                                │ │
│              │ │                                                │ │
│              │ │                                                │ │
│              │ │                                                │ │
│              │ │  ╭─────────────────────────────────────────╮   │ │
│              │ │  │ > _                                     │   │ │
│              │ │  ╰─────────────────────────────────────────╯   │ │
│              │ └────────────────────────────────────────────────┘ │
├──────────────┴────────────────────────────────────────────────────┤
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Sidebar

### Dimensions
- Default width: 220px
- Min width: 180px
- Max width: 400px (implementation; originally specced at 320px)
- Resizable via drag handle on the right edge (`SidebarResizeHandle.tsx`)
- Collapsible with `Ctrl+B` (toggles between full width and hidden)

### Session List Item

Each session in the sidebar is a compact row:

```
┌──────────────────────┐
│ ● NKP OIDC fix       │
│   ~/repos/nkp        │
└──────────────────────┘
```

**Components:**
- **Status dot** (left) — 8px circle, colored by state
- **Label** (primary text) — user-assigned name, truncated with ellipsis if too long
- **Path** (secondary text) — working directory, abbreviated (~ for home, last 2 path segments)

**Status dot colors:**
- `#22C55E` (green) — `running` — Claude is producing output
- `#EAB308` (amber) — `waiting` — Claude is waiting for user input
- `#6B7280` (gray) — `idle` — no recent activity
- `#EF4444` (red) — `dead` / `stopped` — session is not running

The dot should have a subtle pulse animation when in `running` state to draw the eye to active sessions.

**Active session indicator:** The currently-viewed session has a highlighted background (subtle, not aggressive) and a left border accent. The active session's status dot is slightly larger (10px) or has a ring.

**Hover state:** Background highlight, shows a "..." overflow menu icon on the right edge.

**Context menu (right-click or "..." icon):**
- Rename
- Copy path
- Stop (if running)
- Kill (if running/stuck)
- Restart (if stopped/dead)
- Remove from list

### New Session Button

Pinned to the top of the sidebar, always visible. `+` icon with "New session" text.

**Keyboard shortcut:** `Cmd/Ctrl+N`

### Session Grouping — IMPLEMENTED

Sessions are automatically grouped by **working directory** (not by environment type as originally specced). Implementation is in `RepoGroup.tsx`:

- Single session per directory: shown ungrouped as a standalone item
- Multiple sessions per directory: shown in a collapsible group with session count
- Group headers show: directory name, session count, active indicator, collapse/expand chevron
- Groups are collapsible and persist their collapsed state

## Terminal Panel

### Session Header Bar

A thin bar (32px height) above the terminal that shows metadata for the current session:

```
┌────────────────────────────────────────────────────────────┐
│ ● NKP OIDC fix  ·  ~/repos/nkp  ·  sonnet-4  ·  local    │
└────────────────────────────────────────────────────────────┘
```

**Contents (left to right):**
- Status dot (mirrors sidebar)
- Session label
- Working directory (abbreviated)
- Model name (if set; derived from `ANTHROPIC_MODEL` env var)
- Environment type badge: "local", "ssh:hostname", "docker:container"

This bar is purely informational. It does not interfere with the terminal in any way — it sits outside the xterm.js container div.

**Clicking the model name** could open a quick-switch dropdown (post-MVP) or just be a visual indicator for now.

### Terminal Container

The xterm.js terminal fills all remaining space below the header bar. It's the primary UI element — everything else exists to serve it.

**Sizing:**
- The terminal container uses CSS flexbox to fill available height
- xterm.js `fit` addon handles mapping container pixel size → terminal cols/rows
- On every resize event: `fitAddon.fit()` → `transport.resize(cols, rows)`

**Focus behavior:**
- The terminal is always focused when its session is active
- Clicking anywhere in the terminal panel focuses the xterm.js instance
- Switching sessions automatically focuses the new session's terminal
- Sidebar interactions (click, right-click) should NOT steal focus from the terminal unless the user is interacting with a dialog

**Background sessions:**
- Each session has its own `Terminal` instance
- Only the active session's terminal is attached to the DOM (`terminal.open(containerElement)`)
- Background terminals still receive data via `terminal.write()` — they maintain their screen buffer in memory
- When switching to a background session: detach current terminal, attach new terminal to the container
- This is instant — no re-render, no flash, no scroll position loss

### Scrollback
- Default: 5000 lines (configurable in settings)
- xterm.js handles scrollback natively
- Mouse wheel scrolls, `Shift+PageUp/Down` for keyboard scroll
- These are standard xterm.js behaviors — no custom implementation needed

## New Session Dialog — IMPLEMENTED (expanded beyond spec)

Modal dialog triggered by `Ctrl+N` or the sidebar "+" button. Implementation in `NewSessionDialog.tsx`.

The actual dialog is richer than the original spec:

- **Environment selection** — dropdown to pick a preconfigured environment (Local, SSH)
- **Quick-pick repos** — scans a configurable repos root directory for subdirectories, displayed as clickable buttons
- **Directory field** — text input with "Browse" button (OS directory picker) or manual path entry
- **Label field** — optional; auto-generates from directory name if blank
- **Environment variables** — `EnvVarEditor` component showing inherited vars from app defaults + environment, with per-session overrides and quick-add presets
- **CLI flags** — app-wide defaults shown, with quick-add presets (`--dangerously-skip-permissions`, `--verbose`, `--no-telemetry`) and custom flag input
- **Repos root config** — configure the directory scanned for quick-pick repos

**API/Auth configuration** is handled via the environment variable editor rather than the dedicated auth mode UI originally specced. Users set `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, etc. directly as env vars. The `EnvVarEditor` component includes:
- Quick-add presets for all common Claude Code env vars
- Sensitive field detection (keys, secrets, tokens masked by default)
- Inherited vars display showing what's coming from app defaults / environment
- Override button to customize inherited values per-session

The three-mode auth UI (Subscription/API Key/OpenRouter) described in the original spec was not implemented. The env var approach is more flexible and covers all auth backends.

**Create Session** button: spawns the session, adds it to the sidebar, switches to it, and closes the dialog. The terminal is focused and ready for input immediately.

## Settings Dialog — IMPLEMENTED (differs from spec)

Implemented as a modal dialog (`SettingsDialog.tsx`), not a full panel. The actual sections:

**Theme**
- Dropdown with 5 options: Mocha (default), Macchiato, Frappe, Latte, Default Dark
- Theme changes apply immediately and persist across restarts
- Syncs xterm.js terminal colors and titlebar overlay

**Restore Sessions on Launch**
- Toggle to enable/disable workspace save/restore

**Default Environment Variables**
- `EnvVarEditor` component for app-wide env vars
- These are inherited by all sessions unless overridden

**Default CLI Flags**
- Quick-add presets: `--dangerously-skip-permissions`, `--verbose`, `--no-telemetry`
- Custom flag input
- Applied to all sessions unless overridden

**Not yet implemented from original spec:** terminal font/cursor settings, scrollback config, keyboard shortcut rebinding.

## Keyboard Shortcuts

### App-Level (always active) — as implemented in `useKeyboardShortcuts.ts`

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New session |
| `Ctrl+W` | Stop current session |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+1..9` | Switch to session 1-9 |
| `Ctrl+↑` | Previous session |
| `Ctrl+↓` | Next session |

**Not yet implemented:** `Ctrl+Shift+W` (force kill), `Ctrl+,` (settings), `Ctrl+Tab` (last active toggle).

### Terminal-Level (when terminal is focused) — as implemented in `useTerminalManager.ts`

Custom key handling in xterm.js:

- `Shift+Enter` → sends newline (multi-line input, like VS Code terminal)
- `Ctrl+C` → copies text if there's a selection, otherwise passes through to Claude Code (interrupt)
- `Ctrl+V` → pastes from clipboard
- `Ctrl+Shift+C` → always copies (regardless of selection)

All other keystrokes pass through to Claude Code untouched:

- `Ctrl+T` → Claude Code (toggle tasks)
- `Ctrl+L` → Claude Code (clear)
- Arrow keys → Claude Code (history, navigation)
- `/` commands → Claude Code (slash commands)
- `Escape` → Claude Code (cancel)

## Visual Design

### Color Palette — IMPLEMENTED (with theming system)

Tether uses a full theming system with CSS variables (`src/renderer/styles/themes.ts`). Five themes are available:

1. **Mocha** (default) — Catppuccin Mocha (dark)
2. **Macchiato** — Catppuccin Macchiato (dark)
3. **Frappe** ��� Catppuccin Frappe (dark)
4. **Latte** — Catppuccin Latte (light)
5. **Default Dark** — original dark theme

Each theme defines background, text, accent, sidebar, and terminal ANSI palette colors. Theme selection persists via config and syncs to the titlebar overlay.

**Status colors** are defined per-theme as CSS variables, following the original spec values for the default themes:
- Green: running (alive, working)
- Amber: waiting (needs attention)
- Gray: idle (dormant)
- Red: dead/stopped (error)

### Typography

- **Sidebar:** System sans-serif, 13px for labels, 11px for paths
- **Header bar:** System sans-serif, 13px
- **Terminal:** User-configurable monospace font, default to system monospace
- **Dialogs/Settings:** System sans-serif

### Motion

- Session switching: instant (no transition animation — speed over aesthetics)
- Sidebar hover: 100ms background fade
- Status dot pulse: subtle scale animation (1.0 → 1.15 → 1.0) at 2s interval for `running` state only
- Dialog open/close: 150ms fade, no slide

## Accessibility

- All interactive elements are keyboard-accessible
- Focus ring visible on sidebar items when navigating with keyboard
- Status dots use both color AND shape differentiation (filled circle = running/waiting, ring = idle, × = dead) for color-blind users
- High contrast mode: follow OS high-contrast settings, increase status dot size
- Screen reader: sidebar items announce session label + state + environment
