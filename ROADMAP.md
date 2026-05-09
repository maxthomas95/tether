# Roadmap — Tether

This is a living document. The goal is to ship a polished **1.0 (Windows)** by tightening what already exists rather than chasing new surface area. Cross-platform, deeper persistence, and advanced workflows are deliberately deferred to post-1.0.

Status legend: **[planned]** not started · **[in progress]** active · **[blocked]** waiting on something · **[review]** under evaluation, not committed · **[done]** shipped (kept here for context until next release).

---

## Pre-1.0

### 1. Polish the experimental features

#### Split panes
- [planned] Keyboard-driven pane focus and swap (no mouse required)
- [planned] Broadcast input to N panes — high-value for parallel agent runs
- [planned] Recover gracefully when a session inside a layout dies (don't strand the layout)
- [planned] Persist scrollback per pane across re-layouts

#### Usage tracking
- [done] Codex CLI cost tracking — `src/main/usage/codex-jsonl-parser.ts` tracks the active model from `turn_context` lines and sums `last_token_usage` deltas (input, cached, output, reasoning) from `event_msg` `token_count` events; `usage-service.ts` walks `~/.codex/sessions/` on backfill and watches live files on append. Codex models all resolve under bare LiteLLM keys (`gpt-5-codex`, `gpt-5.5`, etc.) so no pricing-prefix fallback was needed.
- [planned] Copilot CLI cost tracking — `events.jsonl` schema for token-bearing events is unverified (no sample available locally). Will need either a real session sample or upstream docs to mirror the Codex parser. Pricing has wide LiteLLM coverage under `github_copilot/*` keys; will require extending `model-pricing.ts:lookupLiteLLM` to try the `github_copilot/` prefix when ingestion lands.
- [done] OpenCode / Crush cost tracking — `usage-service.ts` is now CLI-agnostic; OpenCode sessions read pre-computed cost from `crush.db` (`src/main/opencode/usage-reader.ts`)
- [done] Cost accuracy audit — pricing now sourced from a vendored copy of LiteLLM's `model_prices_and_context_window.json` (`src/main/usage/litellm-prices.json`); covers Anthropic / OpenAI / Google / Bedrock / Vertex etc., with explicit cache-create / cache-read rates when published. Refresh by replacing the JSON. Existing prefix fallback retained for unknown future Anthropic models.
- [planned] CSV / JSON export of usage history
- [planned] Per-environment cost attribution in the global footer
- [planned] Daily / weekly / monthly rollups, not just today + 7-day sparkline

### 2. Bug: status indicator stuck on green/grey

- [done] **P1 investigation** — amber and red statuses never seem to fire in real use. Detector lives at `src/main/status/status-detector.ts`. Need to capture live PTY logs from Claude / Codex / Copilot sessions and tune the cadence heuristics so "waiting on user / tool approval" reliably hits amber and PTY exit hits red.
- [planned] **Smarter waiting signals via CLI hooks** — once the byte-level fix lands, layer in Claude's `Notification`/`Stop` hooks and Codex's `notify` program for higher-fidelity state (distinguish `permission_prompt` from `idle_prompt` → distinct UI sub-state, e.g. amber-with-bang). Needs a design pass on safe config injection: pointing the CLI at a fresh `CLAUDE_CONFIG_DIR` / `CODEX_HOME` loses transcripts and projects, so the path is either (a) merging into the user's existing settings file with conflict-free overlay logic, or (b) overlaying our settings on top of a symlinked/copied config dir per session. Pick after weighing cross-platform symlink constraints (Windows dev-mode requirement).

### 3. Notifications & error surfacing

- [done] Audit `src/renderer/components/Notifications.tsx` — wire up real error paths or remove
- [done] Toast on session spawn failure, transport errors, Vault auth issues, update-check failures
- [done] Keep CHANGELOG known-issues list honest (the "errors only in DevTools" note from 0.3.0 is stale either way)

### 4. Daily-driver UX

- [done] **Reorder sessions** in a sidebar group (drag-to-reorder)
- [done] **Bulk actions** on a group — kill all, restart all, clear all
- [done] **Duplicate carries the source label** — today "Duplicate" passes `''`, so `session-manager.ts` falls back to the working-dir basename and every dupe is named after the repo. Should preserve the source's label with a `(copy)` suffix (`(copy 2)` on subsequent dupes), like Finder / VS Code.
- [done] **Ctrl+scroll** on a terminal pane → terminal font size
- [done] **Ctrl+= / Ctrl+-** → whole-window zoom (UI + terminal together) via `webFrame.setZoomLevel`
- [done] Settings panel for default terminal font size + a reset shortcut
- [done] **Clickable URLs in the terminal** — ctrl-click (or click) to open pasted/printed links in the system browser, like VS Code's terminal. Use `@xterm/addon-web-links` and route through `shell.openExternal` so the main process owns the open.
- [done] **GitHub repo browse** in `NewSessionDialog` — parity with ADO and Gitea (GitHub is the source of truth per project conventions)

### 5. Foundation & quality

- [planned] **Atomic JSON writes** — write-temp + rename in `src/main/db/database.ts`. ~90% of SQLite's reliability benefit for an afternoon of work; lets us keep JSON storage credibly through 1.0.
- [planned] **Test coverage** — transports (`local`, `ssh`, `coder`), IPC handlers (`ipc/handlers.ts`), and Vault resolver are largely uncovered. Currently 7 test files for the whole codebase.
- [planned] **Crash / diagnostics export** — single command to bundle logs + workspace snapshot for support, with secrets scrubbed.
- [planned] **Cross-platform hygiene rule** — codify in CLAUDE.md: no `\\` path literals, no Windows-only shells, no registry assumptions. Keeps post-1.0 cross-platform from becoming a rewrite.

### 6. Repo & folder bootstrapping

Today `NewSessionDialog` assumes the working directory already exists — clone an existing repo, browse the filesystem, or pick a known one. Starting a fresh project means dropping to a shell first.

- [done] **New folder for a new repo** — `NewSessionDialog` has a "New folder" tab (local envs only) that creates a folder under `reposRoot`, optionally `git init`s it, and uses it as the session cwd.
- [done] **Create the remote repo too (GitHub/Gitea/ADO)** — "New folder" mode can optionally provision an empty repo on GitHub, Gitea, or ADO and wires `git remote add origin` locally. Remote-first ordering on failure, first push left to the user. ADO supports a per-provider `defaultProject` selectable from the loaded project list.

### 7. Documentation & discoverability

A lot has shipped recently (Helm, Vault, GitHub provider, OpenCode / Copilot CLI, New-folder + remote-create, terminal zoom, session reorder, bulk group actions, ctrl-clickable URLs, LiteLLM-backed pricing) and the user-facing surfaces — README, in-app docs, dialog copy — haven't kept up. Discoverability is the other half of "polished": features that exist but nobody finds aren't done.

- [planned] **README sweep** — refresh feature list, screenshots, and "what's new" framing for the 1.0 push. Re-evaluate whether `docs/MVP_SCOPE.md` is still load-bearing or should be archived (it predates Helm and multi-CLI). Trim anything that's now contradicted by `CHANGELOG.md`.
- [planned] **In-app docs refresh** (`src/docs/*.md`) — bring `getting-started.md`, `sessions.md`, `environments.md`, `settings.md`, and `keyboard-shortcuts.md` current. Add pages for Vault, Git providers + new-folder / remote-create flow, usage & quota, and the recent UX additions (per-pane font size, window zoom, bulk group actions, drag-reorder, clickable URLs). Helm gets a brief opt-in / how-to note rather than a polished feature page (it's personal-experimental — see `docs/HELM_DESIGN.md`). The docs window is already wired up — this is content work, not plumbing.
- [review] **In-context `(i)` tooltips** — _leaning against, not now._ Idea was to replace the mini-description prose in dialogs (Settings, NewSession, NewEnvironment) with hoverable info-icon tooltips so layout breathes. The catch: a lot of the existing hint copy is consequence/warning text ("Disable if you hit layout bugs", "changes Tether's surface area", "Turn this off if you use plain shells, vim, or htop") that users shouldn't have to hover to see. Hover is also mouse-only and Settings is visited rarely, so there's little expert-speed payoff. If revisited, scope to label-clarifier hints only (e.g. Vault OIDC field captions), not the consequence text. Likely better solved by sectioning Settings (see below) than by hiding copy.
- [planned] **Split Settings into sections / tabs** — `SettingsDialog.tsx` is ~1170 lines / 35 inline hints in a single 70vh scroll with no headers; cognitive load is the bigger UX problem than copy density. Group into clear sections (Appearance, Terminal, Experimental, Sessions, CLI flags, Notifications, Vault, Git providers) via a left-rail nav (VS Code-style) or top tabs. Should be done before re-evaluating the tooltip question — once density is fixed in-place, the tooltip swap may not be needed at all.
- [planned] **Per-section `(?)` deep-links into docs** — small help icon at the top of each major dialog section / sidebar block that opens the docs window scrolled to the matching anchor (e.g. SettingsDialog → Vault row → `settings.md#vault`). Needs anchor IDs in the markdown plus an `openDocs(anchor)` IPC. Pairs naturally with the docs refresh above — do them in the same pass so anchors land alongside the content.


---

## Post-1.0

These are deferred on purpose. We'll revisit when 1.0 has soaked.

- **Cross-platform builds** — macOS first (signing infra is the lift), then Linux. node-pty / ssh2 / Coder REST are already platform-agnostic; the work is at the build / sign / install / auto-update layer.
- **SQLite migration** — only if usage history scale or query performance starts to bite. Likely path is hybrid: config stays in JSON, usage/transcript index moves to SQLite. `better-sqlite3@^12.8.0` may have eased the original Electron-41 ABI pain — to be verified when it matters.
- **Session search** — Ctrl+P-style finder across all sessions. Skipped for 1.0; revisit if the sidebar gets unwieldy at higher session counts.
- **Pin sessions** — pin a session to the top of its group.

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
