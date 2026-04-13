# Sessions

A session in Tether is a running instance of a CLI tool in a specific directory and environment. You can have multiple sessions open simultaneously, each in its own terminal.

## Creating Sessions

Click **+ New session** or press **Ctrl+N** to open the session creation dialog. You can configure:

- **Environment** -- which machine to run on (Local, SSH, or Coder)
- **CLI tool** -- Claude Code, Codex CLI, OpenCode, or a custom binary
- **Working directory** -- where the selected CLI starts. Browse with the folder picker or type a path
- **Label** -- optional display name (defaults to the directory name)
- **Environment variables** -- key-value pairs passed to the CLI process
- **CLI flags** -- additional command-line arguments
- **Launch profile** -- a preset of env vars and CLI flags (see [Settings](settings))

### Resume Conversation

When creating a local Claude Code or Codex CLI session in a directory with existing transcripts, Tether offers to resume a previous conversation. Click the transcript preview to start from where you left off.

## Session States

Each session has a state, shown by the colored dot in the sidebar:

| State | Color | Meaning |
|-------|-------|---------|
| **Running** | Green | The CLI is actively generating output |
| **Waiting** | Amber | The CLI is waiting for your input |
| **Idle** | Gray | Session is alive but not actively processing |
| **Stopped** | Gray (dim) | Session was stopped gracefully |
| **Dead** | Red | Session process has exited |

State detection is passive -- Tether monitors output cadence without intercepting or parsing the terminal stream.

## Managing Sessions

### Renaming

Double-click a session label in the sidebar, or right-click and choose **Rename**. Press Enter to confirm or Escape to cancel.

### Stopping

**Ctrl+W** sends a graceful stop signal to the active session. You can also right-click a session and choose **Stop**. This sends SIGTERM to the CLI process, giving it a chance to clean up.

### Killing

If a session doesn't respond to stop, right-click and choose **Kill**. This sends SIGKILL -- the process is terminated immediately with no cleanup.

### Removing

Right-click a session and choose **Remove** to remove it from the sidebar. This also kills the session if it's still running.

### Duplicating

Right-click a session and choose **Duplicate** to create a new session with the same environment, working directory, and configuration.

## Session Grouping

Sessions are grouped by environment in the sidebar. All local sessions appear under "Local", SSH sessions under their host name, etc. Groups are collapsible -- click the group header to expand or collapse.

Within each group, sessions are further organized by working directory.

## Workspace Persistence

Tether saves your open sessions and layout when you close the app. On next launch, your workspace is restored -- same sessions, same positions, same active session.
