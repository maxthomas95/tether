# Settings

Open Settings with **Ctrl+,**, the button at the bottom of the sidebar, or **View** in the menu bar. Search for a settings section by name or topic, such as “theme”, “hooks”, or “usage”. The dialog has eight sections:

- [General](#general) — session restore and update checks
- [Appearance](#appearance) — theme previews, UI font, and interface density
- [Terminal](#terminal) — terminal font, cursor shape, and scrollback
- [Sessions](#sessions) — default CLI, Helm toggle, default env vars, per-CLI flag presets, launch profiles
- [Notifications](#notifications) — desktop notification triggers and suppression
- [Shortcuts](#shortcuts) — keyboard shortcut customization
- [Integrations](#integrations) — Vault, Git providers, SSH known hosts, diagnostics, J.O.B.S. office
- [Usage](#usage) — cost tracking, history dialog, exports, subscription quota

Use **Save** to apply settings changes. Theme selection previews immediately and reverts on **Cancel**. Actions with their own buttons apply immediately: shortcut edits, profile and provider changes, known-host revocation, Vault login/logout and migration, **Test now** for J.O.B.S., exports, and resetting session font sizes. The dialog's **Cancel** button does not undo those actions.

## General

### Session restore

Controls what happens to your sessions when you quit and relaunch Tether:

- **Restore sessions on launch** — automatically reopen your saved workspace (sessions and pane layout) when Tether starts.
- **Resume previous conversations** — reopen a saved Claude Code, Codex CLI, GitHub Copilot CLI, or OpenCode conversation when its local history is available. Local environments only; SSH and Coder sessions always start fresh.
- **Show a badge on resumed sessions** — adds a small ↻ marker next to sessions that were resumed from a prior conversation.
- **Enable conversation resume** — lets you manually pick an older conversation for any of those four tools in a local working directory. See [Sessions](sessions.md#resume-conversation).

Restore, automatic conversation resume, and the manual resume picker are on by default. The resumed-session badge is off by default.

### Update checks

**Check for updates on launch** is on by default. Tether checks GitHub Releases once, about 15 seconds after launch. Updates are non-blocking — when one is available you'll get a toast pointing to the release page, where you can download and install it. You can also check manually from **Help → Check for Updates…**.

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

## Appearance

### Theme

Tether ships with seven built-in themes:

| Theme | Style |
|-------|-------|
| **Catppuccin Mocha** | Dark (default) — warm muted pastels |
| **Catppuccin Macchiato** | Dark — slightly lighter than Mocha |
| **Catppuccin Frappé** | Dark — cooler than Mocha |
| **Catppuccin Latte** | Light — cream background |
| **Brass** | Dark — warm rope / canvas / copper palette |
| **Tether (Default Dark)** | Dark — cool graphite surfaces and cyan focus accents |
| **Tether Light** | Light — VS Code Light+ inspired, white canvas |

The theme applies to the entire app: title bar, sidebar, terminal, dialogs, and this documentation window. The documentation window uses the same palette definitions as the main window.

Theme selection previews the main window immediately. **Save** keeps the preview and updates the documentation window; **Cancel**, **Escape**, or the close button restores the theme you started with. Theme changes from the View menu and setup wizard still save immediately.

### UI font family

Pick the font used in the sidebar, dialogs, and menus:

| Preset | Notes |
|--------|-------|
| **Default (IBM Plex Sans)** | Tether's identity face |
| **Inter** | Bundled — clean geometric sans |
| **Atkinson Hyperlegible** | Bundled — optimized for readability |
| **System default** | Uses the OS's UI font (Segoe UI on Windows) |

### Interface density

**Comfortable** provides a wider initial sidebar and roomier pane headers. **Compact** reduces sidebar spacing and header height. Density and UI font changes apply when you save; terminal text keeps its independent font size. You can still resize the sidebar manually.

## Terminal

### Default font size

Sets the default terminal font size (8–32 pixels; default 14). Saving applies it to panes without a **Ctrl+scroll** override. Overrides last for the session's lifetime. **Reset all session font sizes** clears them immediately so every pane uses the saved default. **Ctrl+0** resets whole-window zoom, not terminal font overrides.

### Scrollback buffer

Number of lines of output kept per pane (100&ndash;100,000; default 10,000). Larger values keep more history at the cost of memory per pane. Changes apply to existing panes when you save. Scrollback survives pane rearrangement during the app run; it is not saved across app restarts.

### Terminal font family

Pick from five presets:

| Preset | Notes |
|--------|-------|
| **Default (Cascadia Code)** | Cascadia Code, with bundled JetBrains Mono and system fallbacks |
| **JetBrains Mono** | Bundled with Tether |
| **Fira Code** | Must be installed on the OS |
| **Cascadia Code** | Same face as the default, with a plain Consolas fallback stack |
| **Consolas** | Bundled with Windows |

This only affects terminal panes. **Appearance → UI font family** controls the interface font separately. Other faces need to be installed on your machine; each preset includes fallback fonts.

### Hide terminal cursor

Hides the xterm.js cursor. On by default to avoid a second cursor in CLIs that draw their own input indicator. Turn it off for plain shells or apps that use the terminal cursor. When on, the cursor shape and blink controls below are disabled.

### Cursor shape & blink

When the xterm.js cursor is visible, pick its shape (block / underline / bar) and whether it blinks.

## Sessions

Common CLI defaults and launch profiles appear first. Expand **Advanced session options** for Helm, CLI status hooks, pane splitting, and the maximum pane count. These options keep their existing opt-in behavior.

### Allow Helm

Unlocks the per-session "Enable Helm" toggle, which lets a designated Claude session dispatch pre-briefed child sessions via the `tether-helm` MCP. Leave off unless you're specifically using this. See [Helm](helm.md).

### CLI hooks

When on, Tether installs an additive entry in your `~/.claude/settings.json` and `~/.codex/config.toml` so Claude/Codex tell Tether directly when a turn finishes or input is needed. This produces more accurate waiting/idle status detection than passive output observation alone. Takes effect on the next Tether launch.

SSH environments can extend this to their remote hosts, but only with a second, per-environment opt-in — see [CLI status hooks on remote hosts](environments.md#cli-status-hooks-on-remote-hosts). With the global toggle on and the environment checkbox off, remote sessions stay on cadence-only detection and nothing is written to the host.

### Enable pane splitting

Turns on drag-to-split and the split pane layout. When off, sessions always open full-screen in the terminal area. See [Getting Started](getting-started.md#split-panes).

**Maximum panes** sets a limit of 1, 2, or 4 (default 4 when splitting is enabled). The title bar's **Layout** control changes the same settings immediately. Lowering the limit leaves other sessions running in the sidebar.

### Default CLI tool

The CLI tool preselected when you open the New Session dialog. Pick Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, or Custom. Custom also stores the binary name/path to prefill in the session form.

### Default environment variables

Key-value pairs applied as the **global defaults** for every new session. Common examples:

- `ANTHROPIC_API_KEY` — for Claude Code
- `OPENAI_API_KEY` — for Codex CLI
- Project-specific tokens, proxy settings, etc.

Sensitive env-var names (API_KEY, TOKEN, SECRET, PASSWORD, etc.) are encrypted at rest via OS keychain storage; other values are stored plaintext in `data.json`. For best practice, store sensitive values in [Vault](vault.md) and reference them instead.

### Default CLI flags (per tool)

Default command-line flags appended whenever a session of that CLI tool is launched. Separate presets are available for Claude Code, Codex CLI, GitHub Copilot CLI, and OpenCode. Use **Add Flag** for additional flags for the selected tool. Custom binaries accept flags in the New Session dialog; they do not have a preset tab here. Multi-token entries like `--permission-mode plan` are split on whitespace. Entries in `--flag=value` form are kept together. This is not a shell-style quoted-argument parser.

### Launch profiles

A **launch profile** is a named preset of env vars and CLI flags. Quick-switch between configurations when creating sessions — for example, subscription mode vs. API key mode, or different model settings.

Each profile has:

- **Name** — a descriptive label
- **Environment variables** — key-value pairs specific to this profile
- **CLI flags** — command-line arguments specific to this profile
- **Default** — one profile can be marked as default; it pre-selects in the New Session dialog

When you pick a profile, env vars merge in this order: global defaults → environment → profile → session overrides. CLI flags concatenate in this order: per-tool global defaults → per-tool profile flags → session flags. The launch form lets you disable inherited flags individually.

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

Configure the optional **Webhook token** separately instead of embedding credentials in the endpoint URL. Tether sends it as a Bearer token and stores it encrypted with the OS keychain; saving it fails rather than falling back to plaintext when the keychain is unavailable.

Muting a session suppresses both desktop notifications and generic webhook posts for that session.

Individual sessions can be muted from the right-click menu in the sidebar — see [Sessions](sessions.md#muting-notifications).

## Shortcuts

App actions in [Keyboard Shortcuts](keyboard-shortcuts.md) are remappable here. Click a shortcut row, press the new chord, and it's saved immediately. Reserved chords such as **Ctrl+C** require confirmation. Terminal clipboard and mouse gestures are separate from this editor. Click **Reset all** to restore defaults.

## Integrations

### Vault

Configure HashiCorp Vault KV v2 with browser-based OIDC login. Tether caches the login token encrypted with the OS keychain. Env-var values can use `vault://mount/path/to/secret#key` references. See [Vault](vault.md) for setup, token expiry, and migration.

### Git providers

Register GitHub, Azure DevOps, and Gitea credentials so the **Clone** and **New folder** tabs in New Session can browse your repos and create new ones. See [Git Providers](git-providers.md).

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

The J.O.B.S. token is stored encrypted with the OS keychain. Tether refuses to save it if the keychain is unavailable.

### Diagnostics export

Open **About → Export diagnostics for support** to create a zip containing a scrubbed copy of `data.json`, rotated logs, and a version/OS manifest. Credentials and encrypted secret values are redacted; Vault references are preserved. Log scrubbing removes recognized credential patterns. The export is in About, not a control in this settings section.

## Usage

### Tracking

Usage is read from local Claude Code and Codex CLI transcripts, Claude/Codex sessions launched through SSH or Coder, and the supported local Crush database reader attributed to OpenCode. See [Usage & Quota](usage-quota.md#how-it-works) for coverage and limitations. These display controls do not stop usage collection:

- **Show per-session cost strip below terminal** — on by default.
- **Show global usage in sidebar** — on by default.
- **Show per-CLI tool breakdown in usage footer** — off by default; available when global usage is shown.

There is no manual resync or usage-collection toggle in Settings.

Claude and Codex sessions on SSH and Coder also feed these totals. Remote
collection is independent of CLI status hooks. See [SSH and Coder usage](usage-quota.md#ssh-and-coder-sessions)
for host requirements, sudo behavior, and the **Last collected** indicator.

### Budget guardrails

Set **Daily budget warning (USD)** or **Weekly budget warning (USD)** to a positive dollar amount to enable local warning guardrails. Blank or `0` disables a guardrail.

When the current UTC day or Monday-Sunday UTC ISO week crosses its threshold, Tether shows one in-app warning for that period and turns the global usage footer amber while crossed.

### History dialog

Click the global usage footer at the bottom of the sidebar to open a Usage history dialog with Today / 7d / 30d / All-time tiles and tabbed Daily / Weekly / Monthly tables.

### Export

Two buttons here — **Export as CSV…** and **Export as JSON…**. CSV is one row per session with totals (RFC 4180 quoted); JSON includes the full per-model breakdown, daily rollups, and Tether version. See [Usage & Quota](usage-quota.md#export).

### Subscription quota

**Show usage quota in sidebar** is on by default. It enables subscription-quota polling using local Claude/Codex login credentials. Disable it to stop that polling. See [Usage & Quota](usage-quota.md#quota-tracking).

## Data Storage

Tether stores its configuration and session data in a JSON file:

```
{userData}/data.json
```

Where `{userData}` is your OS user data directory (`%APPDATA%/Tether` on Windows). The file contains configuration, session metadata, saved workspace/layout, launch profiles, usage summaries, recent project locations, provider configs, and SSH known-hosts entries. Provider tokens, SSH passwords, secret-bearing settings, and sensitive env-var values are encrypted at rest; Vault references remain references. Writes are atomic (tmp file → fsync → rename) and retry on transient file locks. CLI transcripts remain in the CLI's own storage.

Pricing data is cached at `{userData}/litellm-prices.json`, refreshed at most once a day from `raw.githubusercontent.com`. If you're on a locked-down network, see the project README for the full list of outbound destinations.
