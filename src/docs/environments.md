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

### Coder (Planned)

Connect to Coder workspaces for containerized development environments. This integration is planned for a future release.

## Creating an Environment

1. Click the **+** button next to the environment dropdown in the New Session dialog
2. Choose the environment type (Local or SSH)
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
