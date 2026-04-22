# Transport Design — Tether

## Overview

The transport layer is the core abstraction that makes Tether environment-agnostic. Every session, regardless of where it runs, communicates through the same interface. The terminal panel doesn't know if it's talking to a local PTY, an SSH channel, or a container exec session.

This document specifies the transport interface, the implementation details for each adapter, and the data flow from PTY to screen.

## Transport Interface

```typescript
// src/main/transport/types.ts

interface SessionTransport {
  /** Spawn Claude Code in the target environment. Resolves when PTY is ready. */
  start(options: TransportStartOptions): Promise<void>;

  /** Write raw bytes to PTY stdin (keyboard input from xterm.js). */
  write(data: string): void;

  /** Resize the remote PTY (called on xterm.js dimension changes). */
  resize(cols: number, rows: number): void;

  /** Graceful shutdown — sends Ctrl+C, waits for exit. */
  stop(): Promise<void>;

  /** Force kill — immediate cleanup. */
  kill(): void;

  /** Register callback for PTY output data (raw byte stream). */
  onData(callback: (data: string) => void): void;

  /** Register callback for PTY exit (graceful or crash). */
  onExit(callback: (exitInfo: TransportExitInfo) => void): void;

  /** Current connection state. */
  readonly connected: boolean;

  /** Clean up all resources (called when session is removed). */
  dispose(): void;
}

interface TransportStartOptions {
  workingDir: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  cliArgs?: string[];
}

interface TransportExitInfo {
  exitCode: number;
  signal?: string;
}
```

## Data Flow

```
User Keystroke
     │
     ▼
xterm.js terminal.onData(data)
     │
     ▼ (IPC: session:input)
Electron Main Process
     │
     ▼
transport.write(data)           ◄── raw bytes, no modification
     │
     ▼
PTY stdin (local) / SSH channel (remote)
     │
     ▼
Claude Code process
     │
     ▼
PTY stdout
     │
     ▼
transport.onData callback
     │
     ├──► Status Detector (passive copy)
     │         │
     │         ▼
     │    State machine update → IPC: session:state-change
     │
     ▼ (IPC: session:data)
Renderer Process
     │
     ▼
xterm.js terminal.write(data)   ◄── raw bytes, no modification
     │
     ▼
Screen (rendered by xterm.js VT emulator)
```

**Critical invariant:** At no point in this pipeline is the data modified, parsed, filtered, or buffered (beyond what IPC serialization requires). The bytes that Claude Code writes to stdout are the exact bytes that xterm.js receives.

## Local Adapter

### Implementation

Uses `node-pty` (the same library VS Code uses for its integrated terminal).

```typescript
// Simplified from src/main/transport/local-transport.ts

class LocalTransport implements SessionTransport {
  private pty: IPty | null = null;

  async start(options: TransportStartOptions): Promise<void> {
    // Lazy-load node-pty to avoid ABI mismatch crashes at import time
    const nodePty = require('node-pty');

    // Tokenize each cliArgs entry on whitespace so multi-token presets like
    // "--permission-mode plan" become separate process args.
    const tokenized = cliArgs.flatMap(a => a.split(/\s+/).filter(Boolean));

    // On Unix: spawn the binary directly (no shell — avoids metachar interpretation).
    // On Windows: keep the cmd.exe wrapper for proper PTY semantics with node-pty.
    const binary = options.binaryName || 'claude';
    const spawnFile = process.platform === 'win32' ? 'cmd.exe' : binary;
    const spawnArgs = process.platform === 'win32'
      ? ['/c', binary, ...tokenized]
      : tokenized;

    this.pty = nodePty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.workingDir,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
  }

  // write(), resize(), stop(), kill(), onData(), onExit(), dispose()
  // follow the SessionTransport interface
}
```

### Environment Variables

Environment variables are merged in this cascade (last wins):

1. User's shell environment (`process.env`)
2. App-level default env vars (configured in Settings)
3. Environment-level env vars
4. Session-level overrides (configured in New Session dialog)

Common env vars (available as quick-add presets in the UI):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`
- `ANTHROPIC_BASE_URL` (for OpenRouter or custom endpoints)
- `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
- `AWS_PROFILE`, `AWS_REGION`

### PTY Lifecycle

- **Spawn:** `node-pty.spawn()` creates a child process with a pseudo-terminal.
- **The PTY lives in the Electron main process.** If the renderer crashes and restarts, the PTY is still alive. The renderer reconnects by re-attaching the xterm.js instance to the existing data stream.
- **Exit:** When Claude Code exits (user types `/exit`, process completes, crash), `onExit` fires with the exit code. The transport is now inert — `write()` and `resize()` become no-ops.
- **Orphan cleanup:** On app startup, the session registry is scanned for sessions in `running`/`waiting`/`idle` state. If the app PID file shows a different PID than the current process (meaning previous crash), those sessions are marked `dead` and their PIDs are checked for zombie processes to kill.

## SSH Adapter

### Implementation

Uses the `ssh2` npm package for SSH connectivity.

```typescript
// Simplified from src/main/transport/ssh-transport.ts

class SSHTransport implements SessionTransport {
  private client: Client | null = null;
  private stream: ClientChannel | null = null;
  private sshConfig: SSHConfig;

  async start(options: TransportStartOptions): Promise<void> {
    this.client = new Client();

    // Connect with keepalive (10s interval, max 3 missed)
    this.client.connect({
      host: this.sshConfig.host,
      port: this.sshConfig.port || 22,
      username: this.sshConfig.username,
      // Auth: SSH agent (Windows: \\.\pipe\openssh-ssh-agent) or private key file
      agent: this.sshConfig.useAgent ? agentPath : undefined,
      privateKey: this.sshConfig.privateKeyPath ? readFileSync(...) : undefined,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    });

    // On ready: open shell with PTY, send cd + env + claude command
    // Command: cd <workingDir> && env VAR1=val1 VAR2=val2 claude [args]
    // Single quotes in env values are escaped
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  // write(), stop(), kill(), onData(), onExit(), dispose()
  // follow the SessionTransport interface
}
```

### Connection Management

**Initial connection:** SSH handshake → authenticate → open shell channel with PTY → send env exports and `claude` command.

**Keep-alive:** The `ssh2` client supports server keep-alive. Configured with `keepaliveInterval: 10000` (10s) and `keepaliveCountMax: 3` (drop after 30s of no response).

**Reconnection strategy:**
- On SSH channel close or connection error, the session is marked `dead` via the onExit callback
- No automatic reconnection is implemented yet
- The user can create a new session in the same environment to reconnect
- True session resume (using Claude Code's `--resume` flag) is a future feature

**Authentication methods supported (priority order):**
1. SSH agent (if `SSH_AUTH_SOCK` is set)
2. Private key file (user specifies path)
3. Password (discouraged, but supported via prompt)

### Remote Host Requirements

The remote host must have:
- Claude Code CLI installed and in PATH
- A valid Claude Code authentication (logged in, or API key available)
- SSH server accepting connections
- Sufficient permissions for the target working directory

Tether does NOT install Claude Code on remote hosts. This is a manual prerequisite.

### Security Considerations

- SSH private keys are never stored by Tether. We store the path to the key file.
- API keys sent as env var exports are visible in the remote shell history. Mitigation: use `env` command instead of `export` to avoid shell history, or inject via a temp file. This is a known tradeoff to be addressed post-MVP.
- SSH agent forwarding is supported but disabled by default.

## Coder Adapter

Implemented in `src/main/transport/coder-transport.ts`. Connects to a Coder workspace via the Coder REST API plus an SSH-style PTY exec into the workspace's `coder ssh` channel.

Two flows from the New Session dialog:

1. **Connect to an existing workspace** — pick from a list of workspaces fetched via the Coder API, then open a PTY into it.
2. **Create a new workspace from a template** — pick a template, fill out its parameter form, watch live workspace-build progress stream into the dialog, then session opens once the workspace is `running`.

Other notes:
- Self-signed Coder deployments are supported (cert validation can be relaxed per-environment)
- Workspace start is idempotent — restarting a stopped workspace doesn't re-trigger init steps that would fail
- Repos can be auto-cloned into the workspace as part of session creation (handled with platform-aware path/shell quoting)

No Docker adapter is planned. Coder is the target container runtime.

## Performance Considerations

### Data Throughput

Claude Code can produce high-volume output during tool calls (file reads, grep results, etc.). Peak throughput can reach several hundred KB/s of terminal data.

- **Local adapter:** `node-pty` data events fire synchronously in the Node.js event loop. No bottleneck — this is how VS Code handles it.
- **SSH adapter:** Throughput is bounded by network bandwidth and SSH encryption overhead. On a LAN (gigabit), this is negligible. Over WAN, latency is the bigger concern than throughput.
- **Renderer bottleneck:** xterm.js can handle very high write rates, but the DOM rendering is the bottleneck. Only the **active session** should have its xterm.js attached to the DOM. Background sessions accumulate data in their xterm.js buffer (which is pure in-memory state, no DOM interaction).

### Memory Usage per Session

Each xterm.js `Terminal` instance maintains a screen buffer (default: 1000 lines of scrollback). At ~200 bytes per line (generous estimate for wide terminal with ANSI), that's ~200KB per session. With 20 sessions, that's ~4MB of terminal buffers — negligible.

The `node-pty` process itself adds the memory footprint of a Claude Code CLI process per local session (~50-100MB each, mostly the Node.js runtime). This is the real scaling constraint for local sessions. SSH sessions don't have this cost locally — the Claude Code process runs on the remote host.

### IPC Overhead

Electron IPC serializes data as structured clones. For PTY data (strings), this is efficient. The `session:data` event is the hot path — it fires on every chunk of PTY output. Benchmark target: < 1ms overhead per data event including serialization and deserialization.

Optimization: for the active session, consider using a `MessagePort` (transferable) for direct renderer↔main streaming instead of the default IPC channel. This avoids the Electron IPC broker and reduces latency by ~0.5ms per message. Only worth implementing if profiling shows IPC as a bottleneck.
