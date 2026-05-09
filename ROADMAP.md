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

- [done] **P1 investigation** — amber and red statuses never seem to fire in real use. Detector lives at `src/main/status/status-detector.ts`. Need to capture live PTY logs from Claude / Codex / Copilot sessions and tune the cadence heuristics so "waiting on user / tool approval" reliably hits amber and PTY exit hits red.
- [planned] **Smarter waiting signals via CLI hooks** — once the byte-level fix lands, layer in Claude's `Notification`/`Stop` hooks and Codex's `notify` program for higher-fidelity state (distinguish `permission_prompt` from `idle_prompt` → distinct UI sub-state, e.g. amber-with-bang). Needs a design pass on safe config injection: pointing the CLI at a fresh `CLAUDE_CONFIG_DIR` / `CODEX_HOME` loses transcripts and projects, so the path is either (a) merging into the user's existing settings file with conflict-free overlay logic, or (b) overlaying our settings on top of a symlinked/copied config dir per session. Pick after weighing cross-platform symlink constraints (Windows dev-mode requirement).

### 3. Notifications & error surfacing

- [done] Audit `src/renderer/components/Notifications.tsx` — wire up real error paths or remove
- [done] Toast on session spawn failure, transport errors, Vault auth issues, update-check failures
- [done] Keep CHANGELOG known-issues list honest (the "errors only in DevTools" note from 0.3.0 is stale either way)

### 4. Daily-driver UX

- [done] **Reorder sessions** in a sidebar group (drag-to-reorder)
- [planned] **Bulk actions** on a group — kill all, restart all, clear all
- [done] **Duplicate carries the source label** — today "Duplicate" passes `''`, so `session-manager.ts` falls back to the working-dir basename and every dupe is named after the repo. Should preserve the source's label with a `(copy)` suffix (`(copy 2)` on subsequent dupes), like Finder / VS Code.
- [planned] **Ctrl+scroll** on a terminal pane → terminal font size
- [planned] **Ctrl+= / Ctrl+-** → whole-window zoom (UI + terminal together) via `webFrame.setZoomLevel`
- [planned] Settings panel for default terminal font size + a reset shortcut
- [done] **Clickable URLs in the terminal** — ctrl-click (or click) to open pasted/printed links in the system browser, like VS Code's terminal. Use `@xterm/addon-web-links` and route through `shell.openExternal` so the main process owns the open.
- [done] **GitHub repo browse** in `NewSessionDialog` — parity with ADO and Gitea (GitHub is the source of truth per project conventions)

### 5. Foundation & quality

- [planned] **Atomic JSON writes** — write-temp + rename in `src/main/db/database.ts`. ~90% of SQLite's reliability benefit for an afternoon of work; lets us keep JSON storage credibly through 1.0.
- [planned] **Test coverage** — transports (`local`, `ssh`, `coder`), IPC handlers (`ipc/handlers.ts`), and Vault resolver are largely uncovered. Currently 7 test files for the whole codebase.
- [planned] **Crash / diagnostics export** — single command to bundle logs + workspace snapshot for support, with secrets scrubbed.
- [planned] **Cross-platform hygiene rule** — codify in CLAUDE.md: no `\\` path literals, no Windows-only shells, no registry assumptions. Keeps post-1.0 cross-platform from becoming a rewrite.

### 6. Repo & folder bootstrapping

Today `NewSessionDialog` assumes the working directory already exists — clone an existing repo, browse the filesystem, or pick a known one. Starting a fresh project means dropping to a shell first.

- [planned] **New folder for a new repo** — add a configurable "default projects directory" to settings. In `NewSessionDialog`, a third path alongside "Clone" / "Browse": name a folder, it's created under the default location, optionally `git init`, and selected as the session cwd. Plumbing is mostly in place — `gitInit` already exists in `src/main/git/git-service.ts` and is wired through IPC; this is primarily a UI flow.
- [planned] **Create the remote repo too (GitHub/Gitea/ADO)** — extend the above to optionally provision the remote and `git remote add` on first push. Depends on per-provider auth + repo-create scope: GitHub has no client yet (see §4's "GitHub repo browse" — same auth foundation), and the existing Gitea / ADO clients only do browse, not create. Likely too big for 1.0; revisit post-1.0 once the GitHub client lands. The folder-only piece above is independent and ships first.


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
- [done] Clickable URLs in the terminal — ctrl-click pasted/printed links to open in the system browser via `@xterm/addon-web-links` and `shell.openExternal`.
