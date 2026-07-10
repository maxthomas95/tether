# Roadmap — Tether

This is a living document. The goal is to ship a polished **1.0 (Windows)** by tightening what already exists rather than chasing new surface area. Cross-platform, deeper persistence, and advanced workflows are deliberately deferred to post-1.0.

Status legend: **[planned]** not started · **[in progress]** active · **[blocked]** waiting on something · **[review]** under evaluation, not committed · **[done]** shipped (kept here for context until next release).

---

## Pre-1.0

### 1. Polish the experimental features

#### Split panes
- [done] Keyboard-driven pane focus and swap (no mouse required) — Alt+Arrow focuses the neighboring pane (un-maximizing first if needed); Alt+Shift+Arrow swaps the focused pane's session with its neighbor. Wired in `useKeyboardShortcuts.ts` over the existing `getAdjacentPane` / `swapLeafSessions` helpers; new `SWAP_PANES` reducer action keeps swap as a pure session-id exchange. Non-xterm editable targets are guarded so inline rename and dialog inputs keep native arrow behavior.
- [done] Broadcast input to N panes — pane header broadcast buttons select live pane targets; when at least two selected panes are active, input from any selected pane fans out through the normal `session:input` path to every selected session. Non-selected panes remain local, dead/stopped panes are pruned, and the Session menu can clear all broadcast targets.
- [done] Recover gracefully when a session inside a layout dies — defensive in-pane overlay on `state === 'dead'/'stopped'` offering "Restart in this pane" (re-spawn with the dead session's params and `REPLACE_SESSION` so the layout slot is preserved) and "Close pane". Paired with a sidebar pane-location badge so users can also tell at a glance which sessions are mounted, where, and whether their pane is hidden behind a maximize — click to focus + un-maximize.
- [done] Persist scrollback per pane across re-layouts — `useTerminalManager.ts` parks the xterm.js Terminal in a `backgroundTerminals` Map on detach instead of disposing, then moves the same instance's DOM element into the new pane on re-attach. Buffer survives split/unsplit/swap/maximize/session-switch.

#### Usage tracking
- [done] Codex CLI cost tracking — `src/main/usage/codex-jsonl-parser.ts` tracks the active model from `turn_context` lines and sums `last_token_usage` deltas (input, cached, output, reasoning) from `event_msg` `token_count` events; `usage-service.ts` walks `~/.codex/sessions/` on backfill and watches live files on append. Codex models all resolve under bare LiteLLM keys (`gpt-5-codex`, `gpt-5.5`, etc.) so no pricing-prefix fallback was needed.
- [blocked] Copilot CLI cost tracking — blocked on upstream: `events.jsonl` does not persist token usage. The internal `assistant.usage` / `session.shutdown` / `session.usage_info` events are flagged `ephemeral: true` and dropped by the persister (per maintainer-reversed bundle schema in github/copilot-cli#1152). Tracking github/copilot-cli#2947 (open) for persistence; revisit once that lands or if a `COPILOT_PERSIST_USAGE_EVENTS=1`-style flag ships. Fragile workarounds exist (tail `~/.copilot/logs/process-*.log` CompactionProcessor lines, scrape `/usage`) but are bundle-version-specific and not worth shipping in 1.0. Pricing has wide LiteLLM coverage under `github_copilot/*` keys; will require extending `model-pricing.ts:lookupLiteLLM` to try the `github_copilot/` prefix when ingestion lands.
- [done] OpenCode / Crush cost tracking — `usage-service.ts` is now CLI-agnostic; OpenCode sessions read pre-computed cost from `crush.db` (`src/main/opencode/usage-reader.ts`)
- [done] Cost accuracy audit — pricing now sourced from a vendored copy of LiteLLM's `model_prices_and_context_window.json` (`src/main/usage/litellm-prices.json`); covers Anthropic / OpenAI / Google / Bedrock / Vertex etc., with explicit cache-create / cache-read rates when published. Refresh by replacing the JSON. Existing prefix fallback retained for unknown future Anthropic models.
- [done] CSV / JSON export of usage history — Settings → Usage now has "Export as CSV…" and "Export as JSON…" buttons. CSV is one row per session with totals (RFC 4180 quoting); JSON includes the full per-model breakdown, daily rollups, and Tether version. `usageService.getEnrichedSessions()` carries `workingDir` through; serialization lives in `src/main/usage/usage-exporter.ts`.
- [done] Per-environment cost attribution in the global footer — `environmentId` flows through `PersistedSessionUsage`, `SessionUsage`, and `TrackedSession`. Tracked at session create for Claude/OpenCode (handlers.ts) and at toolSessionId-detect time for Codex/OpenCode in `session-manager.ts`. New `aggregateByEnvironment` (`src/main/usage/env-aggregator.ts`) groups sessions into a sorted `byEnvironment[]` exposed on `UsageInfo`; the footer tooltip resolves env names client-side from the existing `environments` list. Backfilled / out-of-band sessions surface in an "Unattributed" bucket.
- [done] Daily / weekly / monthly rollups — global usage footer is now a button that opens a "Usage history" dialog with Today / 7d / 30d / All-time tiles plus tabbed Daily (30) / Weekly (12) / Monthly (12) tables. Pure renderer-side rollup math (`src/renderer/utils/usage-rollups.ts`) over the existing `daily[]` array, ISO-week boundaries (Mon start), no schema change.

### 2. Bug: status indicator stuck on green/grey

- [done] **P1 investigation** — amber and red statuses never seem to fire in real use. Detector lives at `src/main/status/status-detector.ts`. Need to capture live PTY logs from Claude / Codex / Copilot sessions and tune the cadence heuristics so "waiting on user / tool approval" reliably hits amber and PTY exit hits red.
- [done] **Smarter waiting signals via CLI hooks** — Claude `Notification`/`Stop` hook integration shipped in PR #109: `cli-config/` overlay subsystem merges Tether entries into the user's `~/.claude/settings.json` (additive, sentinel-scoped, scrubbed on shutdown and on next-boot crash recovery), bridged into the status detector via a token-authed local socket with a stdlib-only Node helper bundled as a Forge `extraResource`. Adds a `waitingReason: 'idle' | 'permission'` sub-state plumbed through to a focus-aware amber-with-bang sidebar dot (see-once-then-quiet semantics). Phase 1b polish:
  - [done] Codex `notify` overlay — mirror of the Claude overlay for `~/.codex/config.toml`; hand-rolled TOML merger that only touches the top-level `notify =` line, refuses to displace a user-owned notify, scrubs orphans, and routes through the same `tether-cli-hook` binary (`--codex` mode).
  - [done] Settings UI toggle for `cliHooksEnabled` — opt-in checkbox under Settings → Sessions; default-off; only literal `'true'` enables. Takes effect on next launch.
  - [done] SSH remote installation — overlay installed on remote hosts where the CLI runs, enabling higher-fidelity status detection via local hooks.
  - [planned — deferred to 1.x, not in 1.0] Coder workspace remote hook installation — remote workspace sessions fall back to cadence-based status detection until this ships.
  - Known followup: bang re-fires after navigating away from an acked session — to investigate with live tracing.

### 3. Notifications & error surfacing

- [done] Audit `src/renderer/components/Notifications.tsx` — wire up real error paths or remove
- [done] Toast on session spawn failure, transport errors, Vault auth issues, update-check failures
- [done] Keep CHANGELOG known-issues list honest (the "errors only in DevTools" note from 0.3.0 is stale either way)
- [done] **Desktop notifications on session state change** — Electron `Notification` API surface in `src/main/notifications/notification-service.ts`, subscribed to detector transitions and exit codes. Defaults-on for waiting / idle / unexpected-exit / bell, with focus suppression (BrowserWindow.isFocused) and a per-session "Mute notifications" toggle in the sidebar context menu. Bell detection is a single-byte BEL scan inside the existing detector tap (no ANSI parsing), coalesced to once per 2s. Settings → Notifications surfaces all five toggles. Click → focuses the window and selects the session via a new `NOTIFICATION_SESSION_SELECT` IPC channel.

### 4. Daily-driver UX

- [done] **Session search (Ctrl+P quick switcher)** — VS Code-style finder over all sessions, pulled forward from Post-1.0. Default **Ctrl+P** (remappable via the keybinding registry, shows under Settings → Shortcuts and in Session → Find Session…). Regex-free fuzzy subsequence matcher (`src/renderer/utils/session-search.ts`) ranks across label / dir / env / CLI with contiguity + word-boundary + density bonuses; `SessionSearchDialog.tsx` is a focus-trapped `role=listbox` with roving highlight (↑/↓, Enter, Esc, click). Activation reuses the sidebar's `handleSelectSession` path plus the pane-location-badge un-maximize behavior.
- [done] **Reorder sessions** in a sidebar group (drag-to-reorder)
- [done] **Bulk actions** on a group — kill all, restart all, clear all
- [done] **Duplicate carries the source label** — today "Duplicate" passes `''`, so `session-manager.ts` falls back to the working-dir basename and every dupe is named after the repo. Should preserve the source's label with a `(copy)` suffix (`(copy 2)` on subsequent dupes), like Finder / VS Code.
- [done] **Ctrl+scroll** on a terminal pane → terminal font size
- [done] **Ctrl+= / Ctrl+-** → whole-window zoom (UI + terminal together) via `webFrame.setZoomLevel`
- [done] Settings panel for default terminal font size + a reset shortcut
- [done] **Clickable URLs in the terminal** — ctrl-click (or click) to open pasted/printed links in the system browser, like VS Code's terminal. Use `@xterm/addon-web-links` and route through `shell.openExternal` so the main process owns the open.
- [done] **GitHub repo browse** in `NewSessionDialog` — parity with ADO and Gitea (GitHub is the source of truth per project conventions)
- [done] **Themed scrollbars** — `::-webkit-scrollbar` rules in `global.css` bound to existing theme vars (`--bg-hover` thumb, `--bg-active` on hover, transparent track + corner). Replaces the white system scrollbar that bled through against Catppuccin Mocha; tracks every theme automatically including Latte.

### 5. Foundation & quality

- [done] **Atomic JSON writes** — `saveDb()` writes `data.json.tmp` → `fsync` → atomic rename, with EBUSY/EPERM/EACCES retry × 3 (50 ms backoff) for AV / OneDrive transient locks. Orphan `.tmp` is cleaned on startup. ~90% of SQLite's reliability benefit, no new dependency.
- [done] **Test coverage** — transports, IPC handlers, and Vault resolver were largely uncovered. Went from 7 → ~25 test files across:
  - [done] **Vault resolver** — 24 tests covering `parseRef` edge cases, `resolveRef` error paths (vault disabled, no token, missing key, non-string value), and `resolveAll` (mixed input, parallel resolution, partial-failure rejection).
  - [done] **Transports** — local / coder / ssh, 44 tests. Extracted `pty-loader.ts` and `ssh2-loader.ts` for mockability (lazy `require()` inside the transports bypassed Vitest's `vi.mock`); behaviour preserved.
  - [done] **IPC handlers structural refactor** — `handlers.ts` (969 lines, 79 handlers) split into 11 domain modules (`session-handlers`, `env-handlers`, `vault-handlers`, etc.) so each is testable in isolation. Top-level `handlers.ts` is now a 40-line dispatcher.
  - [done] **Per-domain IPC handler tests** — one `*-handlers.test.ts` per domain module via a shared `ipc-test-harness` helper that stubs `ipcMain.handle`/`on` and provides a fake `HandlerContext`; covers arg forwarding, return shape, and side-effect targets (PR #89).
- [done] **Crash / diagnostics export** — "Export diagnostics for support" button in About bundles a scrubbed `data.json` (SSH passwords, plaintext git tokens, sensitive env-var values, vault token redacted; vault refs preserved) plus rotated logs (with light scrubbing for known API key prefixes — `sk-ant-`, `ghp_`, `hvs.` etc.) plus a `manifest.json` of versions / OS / generated timestamp into a single zip.
- [done] **Cross-platform hygiene rule** — codified in CLAUDE.md: no `\\` path literals, no Windows-only shells, no registry assumptions. Carves out the patterns already in use (defensive separator handling, platform-gated `cmd.exe` in transports, OpenSSH named-pipe fallback) so the rule reflects existing code rather than flagging it. Keeps post-1.0 cross-platform from becoming a rewrite.

### 6. Repo & folder bootstrapping

Today `NewSessionDialog` assumes the working directory already exists — clone an existing repo, browse the filesystem, or pick a known one. Starting a fresh project means dropping to a shell first.

- [done] **New folder for a new repo** — `NewSessionDialog` has a "New folder" tab (local envs only) that creates a folder under `reposRoot`, optionally `git init`s it, and uses it as the session cwd.
- [done] **Create the remote repo too (GitHub/Gitea/ADO)** — "New folder" mode can optionally provision an empty repo on GitHub, Gitea, or ADO and wires `git remote add origin` locally. Remote-first ordering on failure, first push left to the user. ADO supports a per-provider `defaultProject` selectable from the loaded project list.

### 7. Documentation & discoverability

A lot has shipped recently (Helm, Vault, GitHub provider, OpenCode / Copilot CLI, New-folder + remote-create, terminal zoom, session reorder, bulk group actions, ctrl-clickable URLs, LiteLLM-backed pricing) and the user-facing surfaces — README, in-app docs, dialog copy — haven't kept up. Discoverability is the other half of "polished": features that exist but nobody finds aren't done.

- [done] **README sweep** — refreshed feature list and framing for the 1.0 push: themed feature groups (Sessions, Environments, Repo bootstrapping, Cost & quota, Secrets, Interface, Operations), a "What's new" section pointing at the polish push, and an updated docs table that drops the historical `docs/MVP_SCOPE.md` link.
- [done] **In-app docs refresh** (`src/docs/*.md`) — `getting-started`, `sessions`, `environments`, `settings`, and `keyboard-shortcuts` brought current; new dedicated pages for Vault, Git providers, Usage & Quota, and Helm. Covers zoom, clickable URLs, GitHub provider, new-folder + remote-create, drag-reorder, bulk group actions, multi-CLI, pane recovery, keybindings tab, diagnostics export, and Coder template create.
- [review] **In-context `(i)` tooltips** — _leaning against, not now._ Idea was to replace the mini-description prose in dialogs (Settings, NewSession, NewEnvironment) with hoverable info-icon tooltips so layout breathes. The catch: a lot of the existing hint copy is consequence/warning text ("Disable if you hit layout bugs", "changes Tether's surface area", "Turn this off if you use plain shells, vim, or htop") that users shouldn't have to hover to see. Hover is also mouse-only and Settings is visited rarely, so there's little expert-speed payoff. If revisited, scope to label-clarifier hints only (e.g. Vault OIDC field captions), not the consequence text. Likely better solved by sectioning Settings (see below) than by hiding copy.
- [done] **Split Settings into sections / tabs** — `SettingsDialog` now renders a VS Code-style left rail with seven groups: General · Terminal · Sessions · Notifications · Shortcuts · Integrations · Usage. `.settings-content` is `height: 70vh` (not max-height) so the dialog stays a stable size as you switch tabs. All hint copy preserved verbatim — only wrappers and per-tab ordering changed.
- [done] **Per-section `(?)` deep-links into docs** — new `openDocs({ page, anchor })` IPC; the marked renderer slugifies headings into ids, the docs renderer parses `page`/`anchor` on cold start, and a runtime `docs:navigate` event handles deep-links when the window is already open (target heading briefly flashes on arrival). Help icons land in SettingsDialog (per section: general / terminal / sessions / notifications / shortcuts / integrations / usage), NewSessionDialog header, and NewEnvironmentDialog header (sub-anchor by env type).


---

## Post-1.0

These are deferred on purpose. We'll revisit when 1.0 has soaked.

- **Cross-platform builds** — macOS first (signing infra is the lift), then Linux. node-pty / ssh2 / Coder REST are already platform-agnostic; the work is at the build / sign / install / auto-update layer.
- **SQLite migration** — only if usage history scale or query performance starts to bite. Likely path is hybrid: config stays in JSON, usage/transcript index moves to SQLite through built-in `node:sqlite`, avoiding a native Electron ABI dependency.
- **Pin sessions** — pin a session to the top of its group.

---

## Done

_Tracked here briefly until the next release; archived to `CHANGELOG.md` after that. Cleared on 2026-05-16 — all prior items are captured in CHANGELOG entries 0.2.x–0.5.0-beta.1._
