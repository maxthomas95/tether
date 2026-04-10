# Environments

Environments define where Claude Code sessions run. Each environment has its own connection settings, default directory, and configuration. Tether comes with a **Local** environment pre-configured.

## Environment Types

### Local

Runs Claude Code directly on your machine using a local PTY (pseudo-terminal). This is the default and requires no additional setup.

### SSH

Connects to a remote machine over SSH and runs Claude Code there. Useful for running sessions on a Linux VM, dev server, or any machine you can SSH into.

SSH environments require:

- **Host** -- hostname or IP address
- **Port** -- SSH port (default: 22)
- **Username** -- your SSH user
- **Authentication** -- either a private key path or password
- **Working directory** -- default starting directory on the remote machine

Tether stores the *path* to your SSH key, never the key itself.

### Coder

Connect to [Coder](https://coder.com/) workspaces for containerized development environments. Tether wraps the `coder ssh` command in a local PTY, so auth and workspace routing are handled entirely by the Coder CLI you already have installed.

Prerequisites:

- The `coder` CLI is installed and on your PATH
- You are logged in: run `coder login <your-deployment-url>` in a terminal
- At least one workspace exists and is **running** (create and start it from the Coder web UI)

Coder environments only need one setting:

- **Coder CLI Path** -- defaults to `coder`. Override only if the binary isn't on your PATH.

When you create a session in a Coder environment, Tether calls `coder list --output json` and shows your workspaces in a dropdown. Pick a running workspace and Tether will spawn `coder ssh <workspace>` and launch Claude Code inside it.

**Phase 1 limitations:**

- The workspace must already be running. Starting/stopping workspaces from Tether is not yet supported.
- Sessions always launch in the workspace's default directory; there is no per-session subdirectory field yet.
- Resume-by-transcript (`--resume`) is not supported for Coder sessions (transcripts live inside the workspace, not locally).

## Creating an Environment

1. Click the **+** button next to the environment dropdown in the New Session dialog
2. Choose the environment type (Local, SSH, or Coder)
3. Fill in the connection details
4. Click **Create**

The new environment will appear in the environment list when creating sessions.

## Environment Settings

Each environment can have:

- **Environment variables** -- key-value pairs applied to all sessions in this environment. These are merged with global defaults and per-session overrides (session-level takes priority).
- **Default working directory** -- the starting directory for new sessions when no directory is specified.

## Managing Environments

Right-click an environment group in the sidebar to:

- **Edit** -- modify connection settings
- **Delete** -- remove the environment (this does not affect running sessions)

The default Local environment cannot be deleted.

## Per-Environment vs Global Settings

Settings are applied in layers:

1. **Global defaults** -- set in Settings (Ctrl+,)
2. **Environment defaults** -- set on the environment
3. **Launch profile** -- selected when creating a session (see [Settings](settings))
4. **Session overrides** -- set when creating a session

Each layer overrides the previous. For environment variables, the merge is key-by-key. For CLI flags, session-level flags replace environment-level flags entirely.
