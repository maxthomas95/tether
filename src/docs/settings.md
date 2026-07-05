# Settings

Open Settings with **Ctrl+,** or from the menu bar under **View**. The dialog has seven sections in a left rail:

- [General](#general) — theme, session restore, and update checks
- [Terminal](#terminal) — font families, cursor shape, scrollback
- [Sessions](#sessions) — default CLI, Helm toggle, default env vars, per-CLI flag presets, launch profiles
- [Notifications](#notifications) — desktop notification triggers and suppression
- [Shortcuts](#shortcuts) — keyboard shortcut customization
- [Integrations](#integrations) — Vault, Git providers, SSH known hosts, diagnostics, J.O.B.S. office
- [Usage](#usage) — cost tracking, history dialog, exports, subscription quota

## General

### Theme

Tether ships with seven built-in themes:

| Theme | Style |
|-------|-------|
| **Catppuccin Mocha** | Dark (default) — warm muted pastels |
| **Catppuccin Macchiato** | Dark — slightly lighter than Mocha |
| **Catppuccin Frappé** | Dark — cooler than Mocha |
| **Catppuccin Latte** | Light — cream background |
| **Brass** | Dark — warm rope / canvas / copper palette |
| **Tether (Default Dark)** | Dark — neutral cool tones, pairs with the logo |
| **Tether Light** | Light — VS Code Light+ inspired, white canvas |

The theme applies to the entire app: title bar, sidebar, terminal, dialogs, and this documentation window.

### Session restore

Controls what happens to your sessions when you quit and relaunch Tether:

- **Restore sessions on launch** — automatically reopen your saved workspace (sessions and pane layout) when Tether starts.
- **Resume previous conversations** — instead of starting each restored session fresh, reopen the same Claude Code or Codex CLI conversation it was on. Local environments only; SSH and Coder sessions always start fresh.
- **Show a badge on resumed sessions** — adds a small ↻ marker next to sessions that were resumed from a prior conversation.
- **Enable "Resume previous conversation..." in the right-click menu** — lets you manually pick an older Claude Code or Codex CLI conversation for a session's working directory. See [Sessions](sessions#resume-conversation).

### Update checks

Tether polls GitHub Releases on a background timer (15 seconds after launch, then daily). Disable here if you're on a locked-down network. Updates are non-blocking — when one is available you'll get a toast pointing to the release page.

### Update channel

Choose which release track you follow:

- **Stable** — only shows final, numbered releases (e.g. `v0.7.0`). This is the default.
- **Beta** — also shows pre-release builds (e.g. `v0.8.0-beta.1`) with the latest features and fixes before they graduate to stable.

The channel takes effect on the next update check.

### Folders

Two quick-access buttons for support and troubleshooting:

- **Open user data folder** — reveals the directory holding `data.json` (environments, sessions, profiles, git providers, known hosts) and the cached LiteLLM pricing table. This is `%APPDATA%/Tether` on Windows.
- **Open logs folder** — reveals Tether's runtime log files. Useful when filing a bug or tailing what the app is doing. Pair with **About → Export diagnostics for support** to bundle a scrubbed copy of these for a bug report.

Both buttons hand off to your OS file manager (Explorer on Windows, Finder on macOS, `xdg-open` on Linux).

## Terminal

### Default font size

Sets the default terminal font size for all new panes. Existing panes keep whatever you set them to with **Ctrl+scroll**. The reset shortcut returns a pane to this default.

### Scrollback buffer

Number of lines of output kept per pane (100&ndash;100,000; default 10,000). xterm.js ships with a 1,000-line default, which agentic CLI output exhausts almost immediately — Tether bumps the default to 10k so you can scroll back through a full Claude or Codex run. Larger values keep more history at the cost of memory per pane; the setting applies immediately to existing panes.

### Terminal font family

Pick from five presets or leave the default:

| Preset | Notes |
|--------|-------|
| **Default (Cascadia Code)** | Bundled with Windows; the xterm.js default |
| **JetBrains Mono** | Must be installed on the OS |
| **Fira Code** | Must be installed on the OS |
| **Cascadia Code** | Same face as the default, with a plain Consolas fallback stack |
| **Consolas** | Bundled with Windows |

This only affects xterm.js panes. Tether's own UI keeps IBM Plex Sans / JetBrains Mono regardless. Missing fonts fall back to Cascadia Code or Consolas.

### UI font family

Pick the font used in the sidebar, dialogs, and menus:

| Preset | Notes |
|--------|-------|
| **Default (IBM Plex Sans)** | Tether's identity face |
| **Inter** | Bundled — clean geometric sans |
| **Atkinson Hyperlegible** | Bundled — optimized for readability |
| **System default** | Uses the OS's UI font (Segoe UI on Windows) |

### Hide terminal cursor

Hides the blinking cursor inside xterm.js panes. Useful when you're just watching output. When on, the cursor shape and blink controls below are disabled.

### Cursor shape & blink

When the xterm.js cursor is visible, pick its shape (block / underline / bar) and whether it blinks.

## Sessions

### Allow Helm

Unlocks the per-session "Enable Helm" toggle, which lets a designated Claude session dispatch pre-briefed child sessions via the `tether-helm` MCP. Leave off unless you're specifically using this. See [Helm](helm).

### CLI hooks

When on, Tether installs an additive entry in your `~/.claude/settings.json` and `~/.codex/config.toml` so Claude/Codex tell Tether directly when a turn finishes or input is needed. This produces more accurate waiting/idle status detection than passive output observation alone. Takes effect on the next Tether launch.

### Enable pane splitting

Turns on drag-to-split and the split pane layout. When off, sessions always open full-screen in the terminal area. See [Getting Started](getting-started#split-panes).

### Default CLI tool

The CLI tool preselected when you open the New Session dialog. Pick Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, or Custom. Custom also stores the binary name/path to prefill in the session form.

### Default environment variables

Key-value pairs applied as the **global defaults** for every new session. Common examples:

- `ANTHROPIC_API_KEY` — for Claude Code
- `OPENAI_API_KEY` — for Codex CLI
- Project-specific tokens, proxy settings, etc.

Values can be `vault://` references — see [Vault](vault#vault-references). Plaintext values are stored in `data.json`; prefer Vault for anything sensitive.

### Default CLI flags (per tool)

Default command-line flags appended whenever a session of that CLI tool is launched. Separate presets for Claude Code, Codex CLI, OpenCode, and any custom binaries you've registered. Multi-token flags like `--permission-mode plan` are tokenized at the transport boundary — write them as a single string with spaces.

### Launch profiles

A **launch profile** is a named preset of env vars and CLI flags. Quick-switch between configurations when creating sessions — for example, subscription mode vs. API key mode, or different model settings.

Each profile has:

- **Name** — a descriptive label
- **Environment variables** — key-value pairs specific to this profile
- **CLI flags** — command-line arguments specific to this profile
- **Default** — one profile can be marked as default; it pre-selects in the New Session dialog

When you create a session and pick a profile, its env vars and CLI flags merge on top of the environment and global defaults. You can still override individual values per-session.

## Notifications

Tether can post OS desktop notifications when a session changes state, and it can also POST a generic outbound webhook to an HTTP endpoint you control. Desktop notifications and webhooks have separate trigger toggles.

| Trigger | When it fires |
|---------|---------------|
| **Waiting for input** | The CLI finishes its turn or hits a permission prompt — the moment the sidebar dot goes amber |
| **Idle** | The session has been silent past the idle timeout |
| **Unexpected exit / Dead** | The CLI exits with a non-zero code and the session state becomes `dead`. Clean exits (`stopped`) stay quiet |
| **Terminal bell** | The CLI emits an ASCII BEL (`\x07`). Coalesced so a noisy session won't spam your notification center |
| **Suppress while focused** | When on, notifications are hidden while Tether's window has focus (the sidebar already tells you) |

The generic webhook is disabled while its URL is blank. When enabled, Tether sends fire-and-forget JSON with the event name, timestamp, and session metadata: id, label, working directory, state, CLI tool, environment id/name when available, and waiting reason when available. It does not include PTY output, environment variables, CLI args, tokens, or secrets. Only `http://` and `https://` URLs are used, and endpoint URLs are not written to logs because they may contain tokens.

Muting a session suppresses both desktop notifications and generic webhook posts for that session.

Individual sessions can be muted from the right-click menu in the sidebar — see [Sessions](sessions#muting-notifications).

## Shortcuts

Every keyboard shortcut in [Keyboard Shortcuts](keyboard-shortcuts) is remappable here. Click a shortcut row, press the new chord, and it's saved. A reserved-chord warn list prevents you from rebinding things like **Ctrl+C** (copy / SIGINT) without a deliberate confirm. Click **Reset all** at the bottom to restore defaults.

## Integrations

### Vault

Configure HashiCorp Vault for secrets. Supports KV v2 with token or OIDC auth. Tether stores the path to your token file (or initiates OIDC login on demand), never the raw token in plaintext. Once logged in, env-var values can use `vault://path/to/secret#key` references. See [Vault](vault) for the full flow.

### Git providers

Register GitHub, Azure DevOps, and Gitea credentials so the **Clone** and **New folder** tabs in New Session can browse your repos and create new ones. See [Git Providers](git-providers).

### SSH known hosts

Manage host keys captured during SSH first-connect (TOFU). Remove an entry to force re-verification on the next connect.

### J.O.B.S. Office

[J.O.B.S.](https://github.com/maxthomas95/JOBS) is a separate self-hosted pixel-art office that visualizes Claude Code agent activity in real time. When the integration is enabled (default), Tether probes `{url}/healthz` once a minute for a running instance. On detection:

- An **Office** pill appears in the sidebar footer (and a **J.O.B.S. Office** item in the View menu) that opens the office over the terminal area.
- Tether narrates **SSH and Coder sessions** into the office via the JOBS webhook API, so remote agents appear alongside the local ones JOBS already sees through its own transcript watcher. Local sessions are deliberately not bridged — JOBS watches `~/.claude/projects` itself.

Settings:

- **Server URL** — where to probe (default `http://localhost:8780`).
- **Token** — sent as Bearer auth on webhook posts; also injected as `JOBS_TOKEN`/`WEBHOOK_TOKEN` when Tether launches the server.
- **Local JOBS folder** — optional path to a JOBS checkout. When set and nothing answers the probe, Tether launches the built server (`dist-server/`) from that folder using Node.js from your PATH, and stops it on quit. An instance Tether didn't start is never touched. The folder must be built first (`npm install && npm run build`) — which means Node is already installed on any machine where this works.
- **Test now** — saves the fields above and re-probes immediately.

### Diagnostics export

The **About** dialog has an **Export diagnostics for support** button that bundles a scrubbed copy of `data.json` (SSH passwords, plaintext tokens, sensitive env-var values, and the Vault token are redacted; Vault references are preserved) plus rotated logs (with light scrubbing for known API key prefixes) into a single zip. Share that file when filing an issue.

## Usage

### Tracking

Per-session and global usage stats are computed from Claude Code and Codex CLI transcript JSONL files (plus OpenCode's local DB and the bundled LiteLLM pricing table). Toggle tracking on/off; resync on demand.

### History dialog

Click the global usage footer at the bottom of the sidebar to open a Usage history dialog with Today / 7d / 30d / All-time tiles and tabbed Daily / Weekly / Monthly tables.

### Export

Two buttons here — **Export as CSV…** and **Export as JSON…**. CSV is one row per session with totals (RFC 4180 quoted); JSON includes the full per-model breakdown, daily rollups, and Tether version. See [Usage & Quota](usage-quota#export).

### Subscription quota

Optional. Tether can poll your Anthropic / OpenAI subscription quota and show the remaining budget in the sidebar footer. Disable here if you're on metered API billing instead. See [Usage & Quota](usage-quota#quota-tracking).

## Data Storage

Tether stores its configuration and session data in a JSON file:

```
{userData}/data.json
```

Where `{userData}` is your OS user data directory (`%APPDATA%/Tether` on Windows). The file contains environments, session history, saved workspace layout, launch profiles, git provider configs (tokens included for non-Vault providers), and SSH known-hosts entries. Writes are atomic (tmp file → fsync → rename) and retry on transient AV / OneDrive locks.

Pricing data is cached at `{userData}/litellm-prices.json`, refreshed at most once a day from `raw.githubusercontent.com`. If you're on a locked-down network, see the project README for the full list of outbound destinations.
