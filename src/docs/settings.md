# Settings

Open Settings with **Ctrl+,** or from the menu bar under **View**.

## Themes

Tether ships with five built-in themes:

| Theme | Style |
|-------|-------|
| **Catppuccin Mocha** | Dark (default) -- warm, muted pastels |
| **Catppuccin Macchiato** | Dark -- slightly lighter than Mocha |
| **Catppuccin Latte** | Light -- the only light theme |
| **Default Dark** | Dark -- neutral gray tones |

Switch themes from the **View** menu. The theme applies to the entire app including the title bar, sidebar, terminal, and this documentation window.

## Launch Profiles

Launch profiles are named presets of environment variables and CLI flags. They let you quickly switch between configurations when creating sessions -- for example, switching between subscription mode and API key mode, or between different model settings.

### Managing Profiles

Profiles are created and managed in the Settings dialog under the **Launch Profiles** section. Each profile has:

- **Name** -- a descriptive label (e.g., "API Mode", "Subscription")
- **Environment variables** -- key-value pairs specific to this profile
- **CLI flags** -- command-line arguments specific to this profile
- **Default** -- one profile can be marked as default; it will be pre-selected when creating new sessions

### Using Profiles

When creating a session, select a profile from the dropdown in the New Session dialog. The profile's env vars and CLI flags are merged with the environment and global defaults. You can still override individual values per-session.

## Environment Variables

Set default environment variables that apply to all new sessions. Common uses:

- `ANTHROPIC_API_KEY` -- your Anthropic API key for Claude Code
- `CLAUDE_CODE_MAX_TOKENS` -- token limit per request
- Custom variables for your development workflow

Environment variables are set in a key-value editor. Variables set here are the global defaults -- they can be overridden per-environment or per-session.

### Vault Integration

For sensitive values like API keys, Tether supports HashiCorp Vault integration. Instead of storing secrets in plaintext, you can use Vault references like `vault:secret/data/path#key`. See the Vault documentation for setup details.

## CLI Flags

Set default CLI flags passed to every Claude Code session. These are appended to the `claude` command when launching sessions.

Like environment variables, CLI flags follow the layered override model: global defaults < environment defaults < session overrides.

## Data Storage

Tether stores its configuration and session data in a JSON file at:

```
{userData}/data.json
```

Where `{userData}` is your OS user data directory (e.g., `%APPDATA%/Tether` on Windows). This file contains environments, session history, saved workspaces, and settings. It does not contain secrets -- those are either in Vault or set as environment variables at runtime.
