# Helm

Helm is an **opt-in, experimental** integration that lets a local Claude Code parent session dispatch child sessions through the `tether-helm` MCP server. It is not on the 1.0 critical path.

## Enabling Helm on a Session

1. Enable **Settings → Sessions → Advanced session options → Allow Helm**, then **Save**.
2. Enable **Helm** when creating a local Claude Code session, or choose **Enable Helm** from an existing session's action menu.
3. Restart an existing session to wire the MCP into its CLI process. Disabling Helm also takes effect on the next session launch.

The MCP bridge is local to Tether. Use a local Claude Code session as the parent; remote SSH/Coder parents cannot reach that local socket and resource path. Other parent CLI tools are not wired with the MCP configuration. Node.js must be on the local PATH to run the MCP server.

## Available Tools

| Tool | Purpose |
|------|---------|
| `list_environments` | Discover configured environment IDs and types. |
| `list_profiles` | List launch profiles and their env-var names, without exposing values. |
| `spawn_session` | Launch a child in a chosen environment with a label and initial prompt. |
| `get_session_status` | Query a session's state and metadata by ID. |
| `kill_session` | Force-stop a session by ID. |
| `list_coder_workspaces` | Find existing Coder workspaces. |
| `list_coder_templates` | Discover templates. |
| `get_coder_template_params` | Inspect required workspace parameters. |
| `create_coder_workspace` | Provision a workspace before dispatching a child into it. |

Children use the requested environment. The CLI and working directory default to the parent's unless supplied; the user's default launch profile applies unless overridden or disabled. For Coder, the working directory is a workspace name, optionally followed by `::<subdirectory>`.

Children appear in the sidebar and use the normal session transports. Their permissions, credentials, and network access come from the selected environment and CLI configuration. Tether's budget guardrails only warn; they do not enforce spending limits.

## Limits

There is no session-list tool, inter-session message broker, automatic completion delivery, or task scheduler. A parent can query a known child's status. Configure only environments and profiles you intend the parent to use.

Helm stays behind the global and per-session toggles. The normal terminal path remains a raw PTY stream.
