# Roadmap — Tether

This is a living document. The goal is to ship a polished **1.0 (Windows)** by tightening what already exists rather than chasing new surface area. Cross-platform, deeper persistence, and advanced workflows are deliberately deferred to post-1.0.

Status legend: **[planned]** not started · **[in progress]** active · **[blocked]** waiting on something · **[done]** shipped (kept here for context until next release).

---

## Pre-1.0

### 1. Polish the experimental features

#### Split panes
- [planned] Keyboard-driven pane focus and swap (no mouse required)
- [planned] Broadcast input to N panes — high-value for parallel agent runs
- [planned] Recover gracefully when a session inside a layout dies (don't strand the layout)
- [planned] Persist scrollback per pane across re-layouts

#### Usage tracking
- [planned] Copilot CLI pricing/coverage audit (newly added tool, may not be priced)
- [planned] CSV / JSON export of usage history
- [planned] Per-environment cost attribution in the global footer
- [planned] Daily / weekly / monthly rollups, not just today + 7-day sparkline

#### Helm
- [planned] Surface child-session telemetry (status, cost, errors) in the helm pane
- [planned] Retry / recover for failed dispatch
- [planned] Per-skill cost rollup
- [planned] Show the brief that was sent to each child (for debugging / auditing)
- [planned] Helm session history view

### 2. Bug: status indicator stuck on green/grey

- [planned] **P1 investigation** — amber and red statuses never seem to fire in real use. Detector lives at `src/main/status/status-detector.ts`. Need to capture live PTY logs from Claude / Codex / Copilot sessions and tune the cadence heuristics so "waiting on user / tool approval" reliably hits amber and PTY exit hits red.

### 3. Notifications & error surfacing

- [planned] Audit `src/renderer/components/Notifications.tsx` — wire up real error paths or remove
- [planned] Toast on session spawn failure, transport errors, Vault auth issues, update-check failures
- [planned] Keep CHANGELOG known-issues list honest (the "errors only in DevTools" note from 0.3.0 is stale either way)

### 4. Daily-driver UX

- [planned] **Reorder sessions** in a sidebar group (drag-to-reorder)
- [planned] **Bulk actions** on a group — kill all, restart all, clear all
- [planned] **Ctrl+scroll** on a terminal pane → terminal font size
- [planned] **Ctrl+= / Ctrl+-** → whole-window zoom (UI + terminal together) via `webFrame.setZoomLevel`
- [planned] Settings panel for default terminal font size + a reset shortcut
- [planned] **GitHub repo browse** in `NewSessionDialog` — parity with ADO and Gitea (GitHub is the source of truth per project conventions)

### 5. Foundation & quality

- [planned] **Atomic JSON writes** — write-temp + rename in `src/main/db/database.ts`. ~90% of SQLite's reliability benefit for an afternoon of work; lets us keep JSON storage credibly through 1.0.
- [planned] **Test coverage** — transports (`local`, `ssh`, `coder`), IPC handlers (`ipc/handlers.ts`), and Vault resolver are largely uncovered. Currently 7 test files for the whole codebase.
- [planned] **Crash / diagnostics export** — single command to bundle logs + workspace snapshot for support, with secrets scrubbed.
- [planned] **Cross-platform hygiene rule** — codify in CLAUDE.md: no `\\` path literals, no Windows-only shells, no registry assumptions. Keeps post-1.0 cross-platform from becoming a rewrite.

---

## Post-1.0

These are deferred on purpose. We'll revisit when 1.0 has soaked.

- **Cross-platform builds** — macOS first (signing infra is the lift), then Linux. node-pty / ssh2 / Coder REST are already platform-agnostic; the work is at the build / sign / install / auto-update layer.
- **SQLite migration** — only if usage history scale or query performance starts to bite. Likely path is hybrid: config stays in JSON, usage/transcript index moves to SQLite. `better-sqlite3@^12.8.0` may have eased the original Electron-41 ABI pain — to be verified when it matters.
- **Session search** — Ctrl+P-style finder across all sessions. Skipped for 1.0; revisit if the sidebar gets unwieldy at higher session counts.
- **Pin sessions** — pin a session to the top of its group.
- **Advanced Helm workflows** — skill marketplace, multi-step orchestration, persistent helm history across restarts.

---

## Done

_Tracked here briefly until the next release; archived to `CHANGELOG.md` after that._

- [done] Multi-CLI tool support (Claude, Codex, Copilot, OpenCode, Custom)
- [done] Coder workspace transport
- [done] Vault integration (KV v2, OIDC, picker, sidebar pill, preflight)
- [done] Tether-managed worktrees
- [done] Helm v0 / v0.5 (opt-in MCP dispatch, Coder workspace tools, packaging)
- [done] SSH host key verification (TOFU + known-hosts)
- [done] Auto-update via GitHub Releases
- [done] Per-session and global usage / cost views
- [done] Subscription quota tracking
- [done] First-run Setup Wizard
