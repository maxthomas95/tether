# UI Design — Tether

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
- Max width: 320px
- Resizable via drag handle on the right edge
- Collapsible with `Cmd/Ctrl+B` (toggles between full width and hidden)

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

### Session Grouping (Post-MVP)

When environment management ships, the sidebar gains collapsible groups:

```
┌──────────────────────┐
│ + New session         │
│                       │
│ ▼ Local          (3)  │
│   ● NKP OIDC fix     │
│   ◉ VoidCode GPU     │
│   ○ uChat PR         │
│                       │
│ ▼ Homelab VMs    (2)  │
│   ○ NetBox dev        │
│   ◌ HA automations    │
│                       │
│ ► Coder NKP      (0)  │
└──────────────────────┘
```

Group headers show: name, session count, collapse/expand chevron. Session count badge shows total, with a smaller indicator for how many are in `running` or `waiting` state.

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

## New Session Dialog

Modal dialog triggered by `Cmd/Ctrl+N` or the sidebar "+" button.

```
┌─────────────────────────────────────────────┐
│  New session                            ✕   │
│                                             │
│  Directory                                  │
│  ┌───────────────────────────────┐ [Browse] │
│  │ ~/repos/                      │          │
│  └───────────────────────────────┘          │
│                                             │
│  Label (optional)                           │
│  ┌───────────────────────────────┐          │
│  │                               │          │
│  └───────────────────────────────┘          │
│                                             │
│  ▶ API Configuration                        │
│                                             │
│         [Cancel]  [Create Session]          │
└─────────────────────────────────────────────┘
```

**Directory field:** Text input with a "Browse" button that opens the OS file picker. Validates that the path exists and is a directory.

**Label field:** Optional short name. If empty, auto-generates from the directory name (last path segment).

**Auth Mode** (collapsed by default, expand with chevron "▶ Authentication"):

The auth section uses a three-option dropdown that changes the visible fields based on selection. See [Design Decisions DD-02](DESIGN_DECISIONS.md#dd-02-auth-model--first-class-support-for-three-modes) for full rationale and capability comparison.

**State 1 — Subscription (default):**
```
│  ▼ Authentication                            │
│                                              │
│  Mode                                        │
│  ┌────────────────────────────────────┐      │
│  │ Subscription (logged-in account) ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  ℹ Uses your logged-in Claude account.       │
│    Run 'claude login' if not authenticated.  │
```

No additional fields. Claude Code uses its native OAuth/login auth.

**State 2 — API Key:**
```
│  ▼ Authentication                            │
│                                              │
│  Mode                                        │
│  ┌────────────────────────────────────┐      │
│  │ API Key (direct Anthropic)       ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  API Key                                     │
│  ┌────────────────────────────────────┐      │
│  │ sk-ant-••••••••••••••••        👁  │      │
│  └────────────────────────────────────┘      │
│                                              │
│  Model (optional)                            │
│  ┌────────────────────────────────────┐      │
│  │ claude-sonnet-4-20250514         ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  Small/Fast Model (optional)                 │
│  ┌────────────────────────────────────┐      │
│  │ claude-haiku-4-5-20251001        ▼ │      │
│  └────────────────────────────────────┘      │
```

Model dropdowns show Anthropic-native model identifiers. Dropdown includes known models as presets but also allows freeform text entry for new model versions.

**State 3 — OpenRouter:**
```
│  ▼ Authentication                            │
│                                              │
│  Mode                                        │
│  ┌────────────────────────────────────┐      │
│  │ OpenRouter                       ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  OpenRouter API Key                          │
│  ┌────────────────────────────────────┐      │
│  │ sk-or-••••••••••••••••         👁  │      │
│  └────────────────────────────────────┘      │
│                                              │
│  Model (optional)                            │
│  ┌────────────────────────────────────┐      │
│  │ anthropic/claude-sonnet-4        ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  Small/Fast Model (optional)                 │
│  ┌────────────────────────────────────┐      │
│  │ anthropic/claude-haiku-4.5       ▼ │      │
│  └────────────────────────────────────┘      │
│                                              │
│  ⚠ Session Memory is not available via       │
│    OpenRouter. Set Anthropic 1P as top       │
│    priority in your OR provider prefs.       │
```

Model dropdowns show OpenRouter-namespaced identifiers (`provider/model`). The warning about Session Memory is always visible in OpenRouter mode.

**Inheritance indicator:** If the environment or app default already has an auth mode configured, show a small label: "Inherited from: [App Defaults]" with a "Override" link that enables the fields for editing. If not overridden, the fields are dimmed and show the inherited values.

**Create Session** button: spawns the session, adds it to the sidebar, switches to it, and closes the dialog. The terminal should be focused and ready for input immediately.

## Settings Panel

Accessible via `Cmd/Ctrl+,` or app menu. Not a dialog — a full panel that replaces the terminal panel temporarily (similar to VS Code's settings).

### Sections

**Default API Configuration**
- Base URL
- API Key
- Default Model
- Default Small/Fast Model
- These are the fallback values for sessions that don't specify their own.

**Terminal**
- Scrollback lines (default: 5000)
- Font size (default: 13px — matches most terminal defaults)
- Font family (default: system monospace)
- Cursor style (block, underline, bar)
- Cursor blink (on/off)

**Appearance**
- Theme: follow system / light / dark
- Sidebar width (with preview)

**Keyboard Shortcuts**
- Table of all shortcuts with ability to rebind

## Keyboard Shortcuts

### App-Level (always active)

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+N` | New session |
| `Cmd/Ctrl+W` | Stop current session |
| `Cmd/Ctrl+Shift+W` | Kill current session (force) |
| `Cmd/Ctrl+B` | Toggle sidebar |
| `Cmd/Ctrl+,` | Open settings |
| `Cmd/Ctrl+1..9` | Switch to session 1-9 |
| `Cmd/Ctrl+↑` | Previous session |
| `Cmd/Ctrl+↓` | Next session |
| `Cmd/Ctrl+Tab` | Last active session (toggle between two) |

### Terminal-Level (when terminal is focused)

All keystrokes pass through to Claude Code except the app-level shortcuts above. This means:

- `Ctrl+C` → Claude Code (interrupt)
- `Ctrl+T` → Claude Code (toggle tasks)
- `Ctrl+L` → Claude Code (clear)
- Arrow keys → Claude Code (history, navigation)
- `/` commands → Claude Code (slash commands)
- `Escape` → Claude Code (cancel)

**The app-level shortcuts must not conflict with Claude Code keybindings.** `Cmd` (macOS) and `Ctrl+Shift` (Linux/Windows) prefixes are safe because Claude Code uses plain `Ctrl+letter` combos. If any conflicts are discovered, the app shortcut yields to Claude Code.

## Visual Design

### Color Palette

Tether should feel like a native terminal application, not a web app. Dark theme by default, with system theme following.

**Background:** Match the terminal background. The sidebar should use a slightly different shade to create visual separation, but not dramatically different. Think VS Code's sidebar vs editor contrast — subtle.

**Accent color:** A single accent for interactive elements (active session indicator, buttons, links). Suggest a muted teal or blue — nothing that competes with Claude Code's own colorful output.

**Status colors:** These are the most important visual elements and should be immediately recognizable:
- Green: `#22C55E` (alive, working)
- Amber: `#EAB308` (needs attention)
- Gray: `#6B7280` (dormant)
- Red: `#EF4444` (dead/error)

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
