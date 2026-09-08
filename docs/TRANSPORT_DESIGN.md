# Transport Design — Tether

## Overview

Every session uses a `SessionTransport` owned by Electron main. The renderer sends input and resize events through IPC and feeds unmodified output into xterm.js. Local, SSH, and Coder sessions share this contract.

This document describes the current implementation. The authoritative interface is [types.ts](../src/main/transport/types.ts); launch and lifecycle coordination live in [session-manager.ts](../src/main/session/session-manager.ts).

## Transport Interface

```typescript
interface SessionTransport {
  start(options: TransportStartOptions): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): Promise<void>;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: TransportExitInfo) => void): void;
  readonly connected: boolean;
  dispose(): void;
}
```

`TransportStartOptions` includes the working directory, resolved env vars, terminal dimensions, CLI args, CLI tool and binary, tool-native session/resume IDs, legacy Claude IDs, an optional Coder clone URL, and an optional initial prompt. `TransportExitInfo` carries an exit code and optional signal.

CLI-specific resume arguments come from [cli-tools.ts](../src/shared/cli-tools.ts). [cli-args.ts](../src/main/transport/cli-args.ts) splits flag entries on whitespace, except entries in assignment form such as `--flag=value`, which stay intact. It is not a shell-style quote/escape parser. The initial prompt is appended as one argument after tokenization.

## Data Flow

```text
xterm.js onData → session:input IPC → transport.write → PTY stdin
PTY stdout → transport.onData → session:data IPC → xterm.js write
                             ↘ passive status/notification tap
```

The terminal output is never filtered, rewritten, or re-rendered by Tether. SSH uses incremental UTF-8 decoding to preserve characters split across network chunks. Buffering for decoding, IPC, and xterm.js scrollback does not change the terminal content.

Current IPC forwards output for all sessions. The renderer keeps background xterm.js terminals off-DOM so their buffers survive switching and re-layout; active panes attach to the DOM. Removing background traffic would need a separate buffering/replay design that preserves scrollback.

## Configuration Cascade

The session manager resolves env vars in this order, with later values winning:

1. Global defaults.
2. Environment defaults.
3. Selected launch profile.
4. Session overrides.

Local and Coder PTYs also inherit the local process environment. SSH launches receive the resolved variables through a quoted remote command. Vault references resolve in main before launch.

CLI flags concatenate: per-tool global defaults → per-tool profile flags → session flags. `disabledInheritedFlags` removes selected entries. There is no environment-level CLI-flag array in this cascade.

## Local Adapter

[local-transport.ts](../src/main/transport/local-transport.ts) lazily loads `node-pty` through `pty-loader.ts`.

- Native executables spawn directly. On Windows, [win-binary-resolver.ts](../src/main/transport/win-binary-resolver.ts) resolves executable names and uses `cmd.exe` only for batch shims or unresolved names that need PATH/PATHEXT lookup.
- The Windows shell fallback quotes arguments through the shared shell helpers and rejects embedded double quotes at that boundary.
- PTYs use `xterm-256color` and `COLORTERM=truecolor`; resize calls reach `pty.resize`.
- Both stop and kill use node-pty's process termination. Platform behavior differs; a Windows stop is not a promise of POSIX SIGTERM handling.
- PTYs live in main and can survive a renderer reload. Renderer reattachment does not restore a buffer destroyed by a renderer crash.

Conversation resume is supported for local Claude Code, Codex CLI, Copilot CLI, and OpenCode when the requested history exists. SSH and Coder do not use Tether's local history picker.

## SSH Adapter

[ssh-transport.ts](../src/main/transport/ssh-transport.ts) uses `ssh2` and opens a shell channel with a PTY.

- Authentication uses the configured private-key path or password, with agent fallback when neither is supplied. [resolve-ssh-config.ts](../src/main/ssh/resolve-ssh-config.ts) handles stored password decryption and Vault references.
- First contact requires host-key approval. A changed known key fails closed; it must be verified and the old entry revoked in Settings before a fresh prompt.
- The connection uses SSH keepalives. The chosen CLI must already be installed and authenticated on the remote host.
- The launch command changes directory and invokes the CLI with quoted env assignments and arguments. Optional sudo elevation is configured on the environment.
- Stop sends Ctrl+C, waits, sends `exit`, then closes the SSH connection. Kill destroys the connection.
- There is no automatic session reconnect or remote PTY reattachment. Restarting creates a new session.

The optional remote status-hook connection is separate from the terminal connection. It requires both the global CLI-hooks opt-in and the environment's **Install CLI status hooks on this host** setting. It installs additive user-config overlays and a Node helper, uses SSH channels without opening another public port, and does not support sudo environments. Its reconnect behavior does not reconnect the terminal session. See [in-app environment help](../src/docs/environments.md).

## Coder Adapter

[coder-transport.ts](../src/main/transport/coder-transport.ts) wraps `coder ssh <workspace>` in a local node-pty process. The Coder CLI handles authentication and routing; it must be installed and logged in.

[coder/workspace-service.ts](../src/main/coder/workspace-service.ts) lists workspaces/templates and creates workspaces through Coder CLI commands, with REST lookup for template parameters. The per-environment insecure-TLS opt-in applies to that API lookup.

- The session working directory identifies a workspace, optionally `workspace::subdirectory`.
- An optional clone URL adds a guarded clone step before changing into the subdirectory and launching the CLI. An existing target directory skips the clone.
- Stop and kill terminate the local Coder PTY process.
- The UI supports workspace creation, not general start/stop management of existing workspaces.
- Coder sessions use cadence-based status detection; remote hook installation is deferred.

## Lifecycle and Performance

The session manager registers output and exit callbacks, updates persisted metadata, and cleans up transports, watchers, timers, and optional integrations. A stop request allows a 3-second grace period before escalation; another stop during the grace period forces a kill. Exit code zero maps to `stopped`; errors map to `dead`.

Startup marks stale active registry entries stopped. There is no app-PID-file zombie scan or heartbeat-based transport reattachment.

Scrollback defaults to 10,000 lines per terminal and is configurable from 100 to 100,000. It is retained in memory during the app run, not persisted to disk. Memory depends on terminal size, content, scrollback, and each CLI process. Profile IPC and rendering before introducing another streaming mechanism.

## Security Boundaries

- Main owns transport credentials, host verification, Vault resolution, and process launch.
- SSH private keys remain in their existing files; Tether stores their paths. Stored SSH passwords and sensitive configuration values use OS-backed encryption.
- Vault references remain references in app configuration; resolved values are passed to the child process.
- Shell quoting belongs at the transport boundary. Preserve the native-launch and Windows shell-fallback distinctions when changing arguments.
- Status, usage, notifications, and hooks remain passive side channels. They must never alter the terminal stream.
