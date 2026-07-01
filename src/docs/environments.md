# Environments

An **environment** defines where a session runs. Each one has its own connection settings, default directory, and configuration. Tether ships with a **Local** environment pre-configured and you can add SSH and Coder environments as needed.

## Environment Types

### Local

Runs the selected CLI directly on your machine via `node-pty`. No additional setup. The default Local environment cannot be deleted.

### SSH

Connects to a remote host over SSH and runs the selected CLI there. Useful for Linux VMs, dev servers, or any host you can SSH into. Tether uses `ssh2` (Node), not OpenSSH; SSH agent fallback works on Windows (OpenSSH named pipe) and POSIX (UNIX socket).

SSH environments need:

- **Host** — hostname or IP
- **Port** — SSH port (default 22)
- **Username** — your SSH user
- **Authentication** — private key path **or** password. Tether stores the *path* to the key, never the key itself. Passwords are persisted in `data.json`; prefer keys.
- **Working directory** — default starting directory on the remote
- **Optional sudo** — if set, every session in this environment runs `sudo -i` after connect

> **Running Claude as root?** Claude Code refuses to start with `--dangerously-skip-permissions` when it detects it's running as root (via sudo, or a `root` login) unless it thinks it's in a sandbox — otherwise it exits straight back to the shell. When Tether launches Claude as root with that flag, it automatically sets `IS_SANDBOX=1` so the flag you asked for takes effect. Set `IS_SANDBOX` (or `CLAUDE_CODE_BUBBLEWRAP`) yourself in the environment's env vars to override this. This guard is POSIX-only, so local Windows sessions are unaffected. (Coder workspaces are not auto-detected — if a workspace runs as root, add `IS_SANDBOX=1` to its env vars manually.)

#### Host key verification

On first connect to a new host, Tether shows a **Host key verification** dialog (TOFU — trust on first use). Approving stores the fingerprint in `data.json` and silently re-verifies on every subsequent connect. If the host key ever changes, the connection is refused and the dialog reopens so you can re-approve or disconnect. Manage known hosts in Settings → Integrations → SSH known hosts.

### Coder

Connects to [Coder](https://coder.com/) workspaces. Tether wraps the `coder ssh` command in a local PTY, so auth and routing are handled by the Coder CLI you already have installed.

Prerequisites:

- The `coder` CLI is installed and on your PATH
- You are logged in: run `coder login <deployment-url>` once in a terminal
- At least one running workspace exists, **or** a template you can create one from

Coder environments have these settings:

- **Coder CLI Path** — defaults to `coder`. Override only if the binary isn't on your PATH.
- **Allow insecure TLS for Coder API lookup** — off by default. Enable only for self-signed internal deployments whose template-parameter API cannot be verified by Node's trust store.

When you create a session in a Coder environment, the New Session dialog calls `coder list --output json` and shows your workspaces in a dropdown. You can also click **Create new workspace** to pick a template, fill in its parameters, and provision a workspace — progress streams into the dialog as the build runs. Once the workspace is running, Tether spawns `coder ssh <workspace>` and launches the selected CLI inside it.

Caveats:

- Sessions launch in the workspace's default directory; there is no per-session subdirectory field
- Resume-by-transcript (`--resume`) is not supported for Coder sessions because transcripts live inside the workspace
- Starting/stopping existing workspaces from Tether is not yet supported — only creation; manage lifecycle from the Coder web UI

## Creating an Environment

1. Click **+ Add environment** in the sidebar header
2. Choose the type (Local, SSH, or Coder)
3. Fill in the connection details
4. Click **Create**

The new environment appears as a top-level group in the sidebar.

## Environment Settings

Each environment can have:

- **Environment variables** — key-value pairs applied to all sessions in this environment. Merged with global defaults and per-session overrides (session-level wins). Values can be `vault://` references.
- **Default working directory** — starting directory for new sessions when none is specified

## Managing Environments

Right-click an environment group in the sidebar to:

- **Edit** — modify connection settings
- **Delete** — remove the environment. Existing running sessions in that environment are not stopped, but you can't create new ones.

The default Local environment cannot be deleted.

## Per-Environment vs Global Settings

Settings are applied in layers:

1. **Global defaults** — set in [Settings](settings) (Ctrl+,)
2. **Environment defaults** — set on the environment itself
3. **Launch profile** — selected when creating a session (see [Settings](settings#launch-profiles))
4. **Session overrides** — set when creating a session

Each layer overrides the previous. Env vars merge key-by-key; CLI flag arrays replace wholesale at each layer.
