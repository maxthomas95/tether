# UI Design — Tether

> **Archived 2026-05-18.** This is the original UI design spec, kept for historical reference. The shipped UI has diverged in many places (session grouping, dialog-based Settings, Catppuccin + Tether themes, pane splitting, sidebar pills/footers, Setup Wizard, etc.). For current shipped behavior see `src/docs/` and live in the app. Inline diff annotations below are frozen and will not be updated.

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

Implemented as a modal dialog (`SettingsDialog.tsx`) with a VS Code-style left rail. Sections: **General · Terminal · Sessions · Integrations · Usage**.

**General**
- Theme dropdown with 6 options: Mocha (default), Macchiato, Frappe, Latte, Tether (house rope/canvas/brass), Default Dark — applied immediately, persisted, synced to xterm.js palette and titlebar overlay
- Restore sessions on launch, resume previous chats, show resume badge, enable resume picker
- Auto-update check on launch toggle
- Open data folder / open logs folder buttons (`shell.openPath(app.getPath('userData' | 'logs'))`)
- UI font family override

**Terminal**
- Default terminal font size + reset per-session font overrides
- Terminal font family override (xterm.js only — UI mono stays on branded face per `UX_REFRESH.md` §1)
- Terminal scrollback buffer size (100–100,000 lines; default 10,000)
- Hide terminal cursor, cursor shape (block/underline/bar), cursor blink

**Sessions**
- Helm opt-in (global "Allow Helm" — see `HELM_DESIGN.md`)
- Pane splitting toggle + max panes
- Keyboard shortcut rebinding (with reserved-chord warn list for `Ctrl+C` etc.)
- Default CLI flags per tool, launch profiles, default env vars

**Integrations**
- Git providers (GitHub, Azure DevOps, Gitea)
- SSH known hosts
- Vault config

**Usage**
- Subscription quota / per-session strip / global usage toggles
- Per-CLI tool breakdown toggle
- Export usage history as CSV / JSON

All sections have `(?)` deep-link icons that open the in-app docs at the relevant heading via the `openDocs({ page, anchor })` IPC.

## Keyboard Shortcuts

### App-Level (always active) — as implemented in `useKeyboardShortcuts.ts`

All app-level shortcuts are user-remappable from Settings → Sessions → Keyboard shortcuts (shipped in 0.5.0-beta.1). Defaults:

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New session |
| `Ctrl+W` | Stop current session |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+1..9` | Switch to session 1-9 |
| `Ctrl+↑` / `Ctrl+↓` | Previous / next session |
| `Alt+←/→/↑/↓` | Focus the neighboring pane (un-maximizes first if needed) |
| `Alt+Shift+←/→/↑/↓` | Swap the focused pane's session with its neighbor |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Window zoom in / out / reset (UI + terminal together) |
| `Ctrl+scroll` (on a pane) | Per-pane terminal font size |

Reserved chords like `Ctrl+C` surface a warning in the rebind UI to prevent accidental clobbering. Broadcast input is enabled per pane via the pane header (not bound by default) — see `SessionItem.tsx` and the pane status strip.

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

Tether uses a full theming system with CSS variables (`src/renderer/styles/themes.ts`). Six themes are available:

1. **Mocha** (default) — Catppuccin Mocha (dark)
2. **Macchiato** — Catppuccin Macchiato (dark)
3. **Frappe** ��� Catppuccin Frappe (dark)
4. **Latte** — Catppuccin Latte (light)
5. **Tether** — house palette: rope/canvas/brass (dark)
6. **Default Dark** — original dark theme

Each theme defines background, text, accent, sidebar, and terminal ANSI palette colors. Theme selection persists via config and syncs to the titlebar overlay.

**Tether (house palette).** Capstone of the Phase 3 identity pass and the showcase for the Phase 2 depth system. Lives alongside Mocha, not as default (per UX_REFRESH decision C); promotion to default is a Phase 4 contingency once it has been used in anger.

- Direction: rope, canvas, brass — slightly warmer than Mocha, with deeper surface differentiation so dialogs and dropdowns float more obviously above the terminal plane.
- Base shifts hue from Mocha's cool blue-purple (`#1e1e2e`) to a parchment-tinted dark (`#1f1c18`); sidebar `#1a1714`; header `#2c2723`. Surface tokens (`--surface-1..4`) widen the gap so `--shadow-opacity` of `0.65` reads cleanly.
- Accent is copper/brass `#c68a5c` instead of Mocha's lavender — single hex, used everywhere the lavender would have been (focus rings, primary buttons, knot indicator on active sessions).
- Status colors keep the project's canonical hexes: green `#22c55e`, amber `#eab308`, gray `#6b7280`, red `#ef4444` — no theme drift.
- xterm 16-color palette is tuned to harmonize with the warmer base — desaturated blues, slightly cool cyan (separated from sage green for cleaner `git diff` reads), brass-tinted yellow — rather than copying Mocha's block. Selection background uses a copper-tinted overlay (`#c68a5c4d`) for clear contrast against the canvas base.

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
