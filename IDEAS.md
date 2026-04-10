# Ideas & Future Work — Tether

A running list of ideas, improvements, and features to explore. Not everything here will get built — this is a brainstorm space.

## Design Philosophy

Tether is a **HUD around Claude Code**, not a replacement. Claude Code is great at what it does — Tether makes it easier to use at scale. If Claude Code already does something well, don't replicate it. Focus on:
- **Organizing** sessions (tabs, groups, sidebar)
- **Configuring** environments (env vars, MCPs, settings injection)
- **Managing** multi-environment workflows (local, SSH, Coder from one place)
- **Persisting** state (save/restore workspaces)

---

## Near-Term (Next Sessions)

### Env Var Injection (Ready to Build)

Before launching `claude`, Tether sends environment variable commands to the PTY. This is how we configure API keys, model preferences, effort flags, etc. — all defined in Tether's UI and applied automatically.

**How it works:**
- Detect the target OS (Windows → `set VAR=value`, Linux → `export VAR=value`)
- Send env commands to the PTY *before* running `claude`
- Configurable at environment level (applies to all sessions in that env) or per-session override

**Example env vars to manage:**
- `ANTHROPIC_API_KEY` — API key injection
- `ANTHROPIC_MODEL` — default model (opus, sonnet, haiku)
- `ANTHROPIC_SMALL_FAST_MODEL` — fast model for background tasks
- `CLAUDE_CODE_MAX_TOKENS` / effort flags
- `ANTHROPIC_BASE_URL` — OpenRouter or custom endpoint
- Custom vars: `DATABASE_URL`, `NODE_ENV`, whatever the project needs

**UX:** Settings panel or per-environment config with a key-value editor. Simple table: Name | Value | Scope (all sessions / this env only).

Already partially implemented — the transport layer accepts `env` in start options. Need: UI for managing env vars, cascade logic (app → env → session), and the OS detection for remote sessions.

### Workspace Save/Restore

Save the current session layout and restore it later — like browser session restore.

**What gets saved:**
- Which sessions are open (directory, environment, label)
- Their positions/order in the sidebar
- Which session was active
- Optionally: the Claude Code `--resume` session ID for conversation continuity

**UX ideas:**
- **Auto-save on quit** — "Restore previous sessions?" on next launch
- **Named workspaces** — save as "Frontend sprint" / "Incident response" / "Friday cleanup", switch between them
- **Quick-switch** — dropdown or Ctrl+Shift+W to swap workspace sets
- Sessions restore as "stopped" initially, then you can click to relaunch (or "Restore All" button)

**Implementation:** Workspace = JSON blob of session configs. Store in data.json under `workspaces[]`. On restore, create sessions from the saved configs.

### Session Config Injection (Bigger Picture)

When you create a session, Tether could automatically configure Claude Code's settings, MCP servers, permissions, hooks, etc. — so every session gets the right setup without manual work across machines.

**What Tether could manage:**
- **MCP servers** — define MCPs in Tether, auto-write `.mcp.json` or inject into `claude_desktop_config.json` before session launch. Different MCP sets per environment (e.g., Slack MCP only on local, DB MCP only on prod VMs)
- **Claude settings** — auto-generate/merge `settings.json` per environment (model preferences, permission allowlists, theme, etc.)
- **CLAUDE.md injection** — maintain CLAUDE.md templates in Tether, auto-write to the working directory on session start (or append to existing). Environment-specific context like "you are on the staging server" or "this repo uses pnpm"
- **Hooks** — define hooks in Tether that get written to `.claude/settings.json` on session start (e.g., auto-lint on file save, notify on session idle)
- **Permission presets** — preconfigure which tools are auto-allowed per environment (e.g., allow all bash on local, restrict on prod)
- **Environment variables** — already partially done (API keys, model), but extend to arbitrary env vars (e.g., `DATABASE_URL`, `NODE_ENV`)

**Config layers (cascade like CSS):**
```
App defaults → Environment → Session override
```
Each level can set, override, or inherit from above. A session in the "Production VM" environment inherits that env's MCP config, permissions, and CLAUDE.md, but can override the model.

**UX ideas:**
- "Config Profiles" — named bundles of settings (e.g., "Frontend Dev", "Backend Debug", "Prod Incident") that you can attach to any environment or session
- Visual diff before session start — "these settings will be applied" preview
- Import/export profiles to share across machines or teammates

**Implementation approach:**
- Store config templates in Tether's data store (JSON)
- On session create, before spawning the PTY:
  1. Resolve the config cascade (app → env → session overrides)
  2. Write/merge `.mcp.json` to the working directory (or temp location)
  3. Set env vars for Claude Code settings that support them
  4. For things that need files on disk (CLAUDE.md, hooks), write them before launch
- For remote sessions (SSH/Coder): write config files via the SSH connection before launching claude

**Open questions:**
- Should Tether own the config files or merge with existing ones? (Merge is safer but more complex)
- How to handle config cleanup when a session ends? (Leave in place vs. revert)
- Should config profiles be version-controlled (git) or just Tether-internal?

### SSH & Remote Polishing
- **Connection test button** in environment config — validate SSH connectivity before saving
- **SSH key passphrase support** — prompt for passphrase if key is encrypted
- **Reconnect action** — right-click a dead SSH session to reconnect (new PTY, same directory)
- **Connection status indicator** on environment group headers (green = reachable, red = unreachable)

### Coder Integration
- **Connect to existing workspaces** via `coder ssh` / `coder config-ssh` approach
- **Workspace picker** — list available Coder workspaces when creating a session
- **Start stopped workspaces** — if a workspace is off, offer to start it before connecting
- **Coder URL + token config** in environment settings

### Session Experience
- **Session resume** — use Claude Code's `--resume` flag to continue a previous conversation
- **Session restart** — relaunch Claude Code in the same directory after it exits
- **Auto-label from git branch** — detect the current git branch in the working directory and use it as the default label
- **Session search/filter** — type-to-filter in the sidebar when you have 10+ sessions

---

## In Discussion — 2026-04-08 brainstorm

A batch of ideas raised during a brainstorm session. Items at the top have been talked through and have design notes; items at the bottom are tagged `(unevaluated)` and need a future pass.

### ~~Worktree-aware session creation~~

**Decided 2026-04-08: Not building.** See [Not Doing](#not-doing) below for the reasoning. Design notes preserved here for reference.

Spawning a new session directly into a fresh git worktree, so each parallel Claude Code session lives on its own branch without polluting the source repo.

**UX shape:**
- Toggle on the New Session dialog: "Create in new worktree"
- When enabled: pick source repo, base branch, target branch name (default: slugified session label)
- Tether runs `git worktree add` to `<repo>/.worktrees/<branch>/` (subfolder default — see decision below)
- Session launches with `cwd` set to the worktree dir
- On session close: prompt "Merge `<branch>` back to `<base>` and push?" with a merge commit (matches user preference for merge over squash). Then prune the worktree.
- Local-only for v1 — remote (SSH/Coder) worktrees are a separate, harder problem
- If source repo is dirty: warn but allow (don't block)

**Decided 2026-04-08:**
- **Location**: subfolder (`<repo>/.worktrees/<name>/`) by default. User prefers no folder sprawl.
- **Mitigation**: auto-write `.worktrees/` to `.git/info/exclude` on first worktree creation (per-repo, not committed) so git itself doesn't see it.
- **Caveat**: tool indexers (ripgrep, editor file watchers, language servers, linters) will descend into `.worktrees/` and double-count files unless told not to. Git's exclude doesn't help these tools.
- **Escape hatch**: provide a setting to override the worktree root to a configurable global path (e.g., `C:\worktrees\<repo>-<branch>\`) for users who hit indexer issues. Default stays subfolder.

**Open questions:**
- Should the branch name be derived from the label or prompted separately?
- Always merge-back on close, or offer Keep / Discard / Merge?

### Native ccline-style statusline + idle/waiting detection (JSONL session tap)

The user uses ccline-style Claude Code statuslines that show cwd, model, cost, context window, etc. — and since Tether is a passthrough terminal those already render fine. But making this **native and toggleable** would be valuable, and it converges with the long-standing "is Claude waiting on me or just idle?" problem.

**Key insight:** Claude Code writes session transcripts to JSONL files at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. These contain model, token usage, cost, turn boundaries, and tool calls. Tailing those files gives us all the ccline data **and** clean turn-boundary signals — without parsing the PTY stream. Stays consistent with the dumb-pipe principle.

This single feature replaces two earlier ideas:
- ccline-style statusline (gets cost/model/context/cwd for free)
- Idle/waiting detection via hooks (not needed — JSONL tells us when an assistant turn ends)

**UX shape:**
- A toggleable strip **below** the terminal panel showing for the active session: `model · ctx% · $cost · status dot`
- Sidebar badges for non-active sessions: small context ring + status dot
- Powered by file watcher on the JSONL transcript, with tolerant parsing (Claude Code's schema will drift)

**Decided 2026-04-08:**
- **Strip placement**: below the terminal (status-bar feel).

**Open questions:**
- For SSH sessions, transcripts live on the remote box — sftp tail in v1, or local-only initially?
- File watching strategy: `fs.watch` (instant) or 1s poll (more portable)?
- How to handle Claude Code version drift in the JSONL schema?

### Git-aware sidebar (shares the statusline strip)

Make the sidebar git-aware, but keep it visually minimal. Couples with the JSONL statusline strip — they share the same UI surface.

**UX shape:**
- **Sidebar**: tiny dirty-dot next to session name when working dir is dirty. No text noise otherwise — branch name is NOT shown in the sidebar.
- **Hover tooltip**: full git status — branch, ahead/behind counts, modified file count
- **Inside the statusline strip** (for the active session): `branch ↑3 ↓0 ●5`
- Live updates via `fs.watch` on `.git/HEAD` and `.git/index`, polling fallback

**Decided 2026-04-08:**
- **Sidebar shows dirty-dot only**, not branch name. Reasoning: sidebar real estate is precious; session labels need to be readable; branch names are often long and would compete with the label; with the worktree-spawn flow the session label often *is* the branch, so showing it twice would be redundant. Branch info is accessible via tooltip + statusline strip.

**Open questions:**
- Update frequency / debounce strategy for noisy index changes?

### Per-environment theming

Visual indicator that the session you're typing into is on prod, not local. Cheap to build, prevents real disasters once SSH envs proliferate.

**UX shape:**
- Optional `accentColor` field per environment, picked in the env config dialog from a small preset palette (no clashing greens)
- Applied to: terminal panel border (1-2px), sidebar group header bar, optional titlebar tint
- Accent only — does **not** override the user's chosen terminal theme. Theme stays a global choice.
- Default off so existing envs are unaffected

**Decided 2026-04-08:**
- **Accent only.** Theme is an aesthetic choice (Catppuccin variant etc.); env color is an informational signal ("you are on prod"). Different layers of meaning, shouldn't compete. A 2px border tint + sidebar group header bar gives enough signal without disrupting how the user reads the terminal.

### Cloud sync of environments and workspaces

User runs Tether on a personal PC and a work PC. Sync would mean configuring envs once and having them available on both.

**UX shape:**
- **Backend: git-based**, since user already runs Gitea. Tether keeps a private sync repo (e.g., `tether-config`).
- **Auto-sync, debounced ~5s** after the last settings change. Pull on launch.
- Manual "Sync Now" button + "last synced X minutes ago" indicator in settings as a paranoia escape hatch.
- Last-write-wins; toast on conflict if it ever happens.
- **Secrets do NOT sync.** Only env definitions, workspaces, snippets, themes, sidebar layout. API keys / SSH creds resolve via Vault per-machine (Vault is per-machine config).
- **Blob is NOT encrypted in v1** — see decision below.
- Bonus: full version history of config for free, since it's a git repo with readable diffs.
- **Sync scope per item**: each environment tagged `syncScope: shared | machine-local`. The work PC has different SSH hosts than personal — those stay machine-local; the rest sync.

**Decided 2026-04-08:**
- **Auto-sync, debounced.** Two-PC solo use means the conflict window is tiny (user isn't at both machines simultaneously). Friction kills sync features; manual sync gets forgotten and PCs drift. Manual button stays as escape hatch.
- **Don't encrypt the blob in v1.** All actual secrets live in Vault per-machine, so the sync blob holds env definitions, themes, snippets — not secrets. Encryption kills the readable-diff version-history benefit and adds key-management complexity. Private Gitea repo on user's own infra is already a strong perimeter. Opt-in encryption (age) can be added later as a setting if desired.

**Open questions:**
- How to bootstrap a fresh machine — one-time clone + token?
- Conflict-resolution UX: silent overwrite with toast, or hard-stop and show a diff?

### Prompt snippets / library

Reusable prompt store with variable substitution. Low priority for the project owner personally, but a clean addition for users who'd want it.

**UX shape (proposed, TBD):**
- Snippet store in `data.json`: `{name, body, shortcut?}` per snippet
- Optional global hotkey sends snippet body to active session
- Variable substitution: `{branch}`, `{cwd}`, `{date}`, `{label}` — so "review the diff on {branch}" expands per session
- Managed under Settings → Snippets
- Per-environment scoping (some snippets only for specific envs)

### Idle vs waiting detection

**Resolved by the JSONL session tap above** — no need for Claude Code hooks, no need for PTY heuristics. Tracking here only because it was raised separately.

### Generic CLI support (multi-tool multiplexer)

**Discussed 2026-04-09.** Make Tether usable as a multiplexer for any CLI tool (Codex, Aider, custom scripts), not just Claude Code.

**Key insight:** The architecture is already ~80% generic. The PTY layer, transport interface, session/environment model, xterm.js rendering, sidebar grouping, theming, and SSH plumbing are all tool-agnostic. Claude-specific coupling is concentrated in: hardcoded `'claude'` spawn command in both transports, `--session-id`/`--resume` flag handling, transcript reader (`~/.claude/projects/*.jsonl`), resume dialog, status detector prompt hints (`❯`), and env var presets (`ANTHROPIC_API_KEY` etc.).

**Decision: Claude is the only first-class citizen.** Other tools get "as-is" support — you get multiplexed terminals with grouping, theming, environments, and SSH, but no tool-specific integrations. Framing: "if it's not Claude, you get a raw multiplexed terminal."

**What "as-is" means concretely:**
- No session resume / `--session-id` tracking
- No transcript browsing (Resume Chat dialog)
- No Claude-specific env var presets
- Status detection falls back to output-cadence-only (no prompt pattern matching)
- User provides the full CLI command; Tether just spawns it

**Implementation approach (when we get to it):**
1. Add a `command` field to environments/sessions (defaults to `'claude'`)
2. When `command !== 'claude'`, skip Claude-specific features
3. Session creation dialog gets a "Custom CLI" option alongside the Claude default, with a text field for the command
4. Optional: small note in UI — "Claude sessions include additional features like session resume and status detection"

**Not building (for now):**
- Tool profiles / plugin system for per-tool integrations
- Per-tool prompt detection patterns
- Per-tool transcript readers
- Per-tool env var presets

**Reconsider if:** demand from other users, or the user starts running non-Claude tools frequently enough that the missing features create real friction.

### Vault integration

**Already in flight in a separate conversation.** Not duplicating the design here. Cross-references the existing IDEAS.md note on encrypted API key storage; once Vault lands, that supersedes Electron safeStorage as the primary secret backend.

---

### Unevaluated — needs a future brainstorm pass

These were proposed but not talked through. One-line capture so they're not lost.

- **"Files touched this session" panel** *(unevaluated)* — snapshot `git status` at session start, show a panel of files Claude has modified since. Click to open in editor.
- **Cost / token meter** *(unevaluated — partially absorbed by JSONL tap)* — aggregate $/tokens per session, per environment, per day. JSONL tap provides the data; the aggregation/reporting UI is separate.
- **Branch-per-session workflow** *(unevaluated)* — auto-create a branch named from the label even without a worktree. Lighter than worktree mode for users who want one branch per task without multiple checkouts.
- **Worktree group view** *(unevaluated)* — sidebar grouping mode that nests all sessions in worktrees of the same parent repo under a parent-repo header.
- **Pre-flight checks before session start** *(unevaluated)* — before spawning Claude, validate: API key resolves, working dir exists, git is sane, disk space ok. "Ready to launch" panel with green/red checks.
- **Broadcast input to N sessions** *(unevaluated)* — select N sessions, type once, keystrokes go to all. Useful for "git pull everywhere" or "update CLAUDE.md across all my repos".
- **Session linking** *(unevaluated)* — explicitly mark sessions as related (frontend + backend for the same feature). Group visually, switch together with one shortcut, notifications fire as a unit.
- **Session parking** *(unevaluated)* — snapshot Claude session ID + cwd + scrollback tail, kill the PTY to free RAM/remote-VM resources. "Unpark" relaunches with `--resume`. Lets you keep 30 sessions conceptually open without 30 live PTYs.
- **Sidebar hover preview** *(unevaluated)* — hovering a session shows the last ~10 lines of its terminal output in a tooltip. Glance without switching.
- **Command palette (Ctrl+P)** *(unevaluated)* — fuzzy launcher for app actions: new session, switch env, kill all idle, jump to session by label.
- **Session templates with parameters** *(unevaluated)* — "New session from template" prompts for params (ticket number, branch) and feeds them into label + env vars + initial prompt.
- **Idle reaper for remote sessions** *(unevaluated)* — auto-stop SSH/Coder sessions after N hours of true idleness. Saves remote VM resources, especially Coder workspaces that bill by uptime.
- **Time tracking** *(unevaluated)* — aggregate active time per session/env/day. Useful for billing, self-awareness, or a "what did I do this week" view.
- **CLAUDE.md quick-edit** *(unevaluated)* — small editor pane to tweak the working dir's CLAUDE.md without leaving Tether.
- **Global hotkey** *(unevaluated)* — Win+`/Cmd+` to summon Tether from anywhere and start a quick session. Spotlight-style.

---

## Medium-Term

### Multi-Model & Auth
- **Per-session model override** — dropdown to pick model (Sonnet, Opus, Haiku) at session creation
- **OpenRouter integration** — inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` for OpenRouter sessions
- **API key management** — encrypted storage via Electron safeStorage (DPAPI on Windows)
- **Quick model switch** — change model mid-conversation by restarting with `--resume` and different `ANTHROPIC_MODEL`

### Sidebar UX Improvements
- **Drag-and-drop reorder** within environment groups
- **Session pinning** — pin frequently-used sessions to the top
- **Last-active sorting** — option to sort sessions by most recently active
- **Collapsible stopped sessions** — group dead/stopped sessions at the bottom
- **Environment badges** showing SSH host, Coder workspace name in compact form
- **Notification dots** — show a badge when a background session transitions to "waiting" (needs your input)

### Terminal Enhancements
- **Split pane** — view two sessions side by side
- **Session tab bar** — optional tab bar above terminal as alternative to sidebar-only navigation
- **Scrollback search** — Ctrl+Shift+F to search terminal output history
- **Session transcript export** — save raw or cleaned terminal output to file

---

## Long-Term / Exploratory

### Desktop Notifications
- **Background session alerts** — desktop notification when a session transitions from "running" to "waiting"
- **Configurable notification rules** — only notify for specific sessions or environments
- **Sound alerts** — optional audio ping

### Agent Orchestration (Layer on Top)
- **Batch prompt** — send the same prompt to multiple sessions simultaneously
- **Session templates** — preconfigured session setups (directory + model + env vars + initial prompt)
- **Workflow automation** — chain of prompts across sessions with dependencies
- **Session monitoring dashboard** — overview of all session states, resource usage, uptime

### Platform & Distribution
- **Migrate Windows installer from Squirrel to NSIS** — Squirrel.Windows installs silently to a fixed `%LocalAppData%\Tether\` path with no install wizard, no install-location picker, and the awkward green progress popup. Move to NSIS (likely via `electron-builder`, which has mature NSIS + code signing support) to get a real installer wizard with install path selection, per-user vs per-machine choice, shortcut options, and a more standard Windows install experience. Will also pair well with Azure Trusted Signing for SmartScreen trust.
- **Code sign Windows builds** — Set up Azure Trusted Signing on a personal Microsoft Entra tenant (~$10/mo) to eliminate the SmartScreen "Windows protected your PC" warning. Requires a personal Entra tenant + Azure subscription so the publisher identity is "Max Thomas" / "Thomas Home Company", not a work org.
- **macOS build** — test and polish on Mac (Cmd key mapping, Keychain for secrets)
- **Linux build** — AppImage or .deb distribution
- **Auto-updates** — Electron auto-updater for seamless updates
- **Portable mode** — run from USB drive with local config

### Integration Ideas
- **VS Code extension** — sidebar panel in VS Code that shows Tether session states
- **CLI companion** — `tether create --dir ~/repos/foo --ssh myvm` to create sessions from terminal
- **Web dashboard** — lightweight web view for checking session states from phone/tablet
- **GitHub integration** — auto-create a session when a PR is assigned to you, pre-configured to the right branch

### Architecture Improvements
- **SQLite persistence** — migrate from JSON when node-gyp/VS 2025 issues are resolved (better query perf at scale)
- **Session log storage** — persist terminal output to disk for search and replay
- **Plugin system** — allow third-party transport adapters (Kubernetes, cloud VMs, etc.)
- **Multi-window support** — detach a session into its own window

---

## Not Doing

Things explicitly decided against, with the reasoning. Different from "Unevaluated" (no decision yet) — these have been thought through and rejected. Listed here so future-me doesn't relitigate the same decision.

### Worktree-aware session creation — 2026-04-08

**Decision:** Don't build a dedicated worktree feature. Just ask Claude in-session to set up a worktree when one is needed.

**Why:**
- **Lifecycle surface area is bigger than the value.** Building this right means handling: indexer thrash from `.worktrees/` subfolders (ripgrep, LSPs, file watchers all double-count and git's `info/exclude` doesn't help them), merge conflicts on close, empty branches with nothing to merge, push failures, the PTY-still-alive-when-pruning ordering gotcha, and re-opening unmerged worktrees later. Each one is small; together they're a real maintenance footprint.
- **Claude Code already handles git well.** "Hey, set up a worktree at X based on Y, other Claudes are working in this repo" gets ~70% of the value with 0% of the maintenance, and Claude handles per-repo conventions and conflict resolution contextually rather than via a dialog box.
- **Tether already sets cwd at session creation**, so the cwd-bootstrap argument doesn't apply — there's no Tether-only capability gap that this feature would close.
- **Single-user project.** The discoverability argument (a checkbox that teaches the workflow) doesn't apply when the user already knows the workflow exists.
- **Remaining friction is tiny.** One sentence of preamble per session, occasionally.

**What to do instead:** Ask Claude in-session. The `feedback_worktrees.md` and `feedback_worktree_workflow.md` memories already capture the user's preferences (subfolder location, merge over squash, merge back to main and push, don't leave as a separate branch).

**Reconsider if:** Tether grows multiple users (discoverability matters again), OR worktree spawning becomes a daily action rather than occasional (friction adds up), OR remote (SSH/Coder) worktree workflows become valuable enough that consistency across environments justifies the code.

---

## Known Issues / Tech Debt

- **VS 2025 + node-gyp**: Native module compilation doesn't work. Using JSON persistence and prebuilt binaries as workaround. Track upstream node-gyp for VS 2025 support.
- **Electron Forge Vite entry naming**: Preload entry must not be named `index.ts` to avoid output collision. Documented in CLAUDE.md.
- **Status detection accuracy**: Prompt heuristics may need tuning with real Claude Code sessions across different models and workflows.
- **No error toasts yet**: Failed session creation shows in DevTools console but not in the UI.

---

*Add ideas freely. Mark items with ~~strikethrough~~ when completed or dropped.*
