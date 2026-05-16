# Settings

Open Settings with **Ctrl+,** or from the menu bar under **View**. The dialog has six sections in a left rail:

- [General](#general) — theme and update checks
- [Terminal](#terminal) — font, terminal-pane behavior, scrollback
- [Sessions](#sessions) — default CLI, default env vars, per-CLI flag presets, launch profiles
- [Shortcuts](#shortcuts) — keyboard shortcut customization
- [Integrations](#integrations) — Vault, Git providers, SSH known hosts, diagnostics
- [Usage](#usage) — cost tracking, history dialog, exports, subscription quota

## General

### Theme

Tether ships with five built-in themes:

| Theme | Style |
|-------|-------|
| **Catppuccin Mocha** | Dark (default) — warm muted pastels |
| **Catppuccin Macchiato** | Dark — slightly lighter than Mocha |
| **Catppuccin Frappe** | Dark — cooler than Mocha |
| **Catppuccin Latte** | Light — the only light theme |
| **Default Dark** | Dark — neutral gray tones |

The theme applies to the entire app: title bar, sidebar, terminal, dialogs, and this documentation window.

### Update checks

Tether polls GitHub Releases on a background timer (15 seconds after launch, then daily). Disable here if you're on a locked-down network. Updates are non-blocking — when one is available you'll get a toast pointing to the release page.

## Terminal

### Default font size

Sets the default terminal font size for all new panes. Existing panes keep whatever you set them to with **Ctrl+scroll**. The reset shortcut returns a pane to this default.

### Terminal behavior

A few terminal-pane toggles (e.g. cursor blink, scrollback length). The hint copy explains the trade-offs per option — most users should leave these at the defaults.

## Sessions

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

## Shortcuts

Every keyboard shortcut in [Keyboard Shortcuts](keyboard-shortcuts) is remappable here. Click a shortcut row, press the new chord, and it's saved. A reserved-chord warn list prevents you from rebinding things like **Ctrl+C** (copy / SIGINT) without a deliberate confirm. Click **Reset all** at the bottom to restore defaults.

## Integrations

### Vault

Configure HashiCorp Vault for secrets. Supports KV v2 with token or OIDC auth. Tether stores the path to your token file (or initiates OIDC login on demand), never the raw token in plaintext. Once logged in, env-var values can use `vault://path/to/secret#key` references. See [Vault](vault) for the full flow.

### Git providers

Register GitHub, Azure DevOps, and Gitea credentials so the **Clone** and **New folder** tabs in New Session can browse your repos and create new ones. See [Git Providers](git-providers).

### SSH known hosts

Manage host keys captured during SSH first-connect (TOFU). Remove an entry to force re-verification on the next connect.

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
