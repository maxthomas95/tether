# Transport Design — Tether

## Overview

The transport layer is the core abstraction that makes Tether environment-agnostic. Every session, regardless of where it runs, communicates through the same interface. The terminal panel doesn't know if it's talking to a local PTY, an SSH channel, or a container exec session.

This document specifies the transport interface, the implementation details for each adapter, and the data flow from PTY to screen.

## Transport Interface

```typescript
interface SessionTransport {
  /**
   * Start the session. Spawns Claude Code in the target environment.
   * Resolves when the PTY is established and ready to receive input.
   * Rejects if the spawn fails (bad path, SSH connection refused, etc.)
   */
  start(options: TransportStartOptions): Promise<void>;

  /**
   * Write raw bytes to the PTY stdin.
   * This is keyboard input from xterm.js — passed through untouched.
   */
  write(data: string): void;

  /**
   * Resize the remote PTY.
   * Called when xterm.js dimensions change (panel resize, window resize).
   */
  resize(cols: number, rows: number): void;

  /**
   * Graceful shutdown. Sends SIGTERM equivalent, waits for exit.
   * Resolves when the PTY has exited.
   */
  stop(): Promise<void>;

  /**
   * Force kill. Sends SIGKILL equivalent, immediate cleanup.
   */
  kill(): void;

  /**
   * Register callback for PTY output data.
   * This is the raw byte stream — ANSI escapes, cursor moves, everything.
   * Multiple listeners allowed (terminal + status detector).
   */
  onData(callback: (data: string) => void): void;

  /**
   * Register callback for PTY exit.
   * Fired when the Claude Code process exits (graceful or crash).
   */
  onExit(callback: (exitInfo: { exitCode: number; signal?: string }) => void): void;

  /**
   * Current connection state.
   */
  readonly connected: boolean;
}

interface TransportStartOptions {
  /** Working directory for Claude Code */
  workingDir: string;

  /** Environment variables to inject (OpenRouter config, etc.) */
  env: Record<string, string>;

  /** Initial terminal dimensions */
  cols: number;
  rows: number;

  /** Optional: Claude Code CLI arguments (e.g., --model, --resume) */
  cliArgs?: string[];
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
// Conceptual implementation — not final code

class LocalTransport implements SessionTransport {
  private pty: IPty | null = null;

  async start(options: TransportStartOptions): Promise<void> {
    this.pty = spawn('claude', options.cliArgs || [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.workingDir,
      env: {
        ...process.env,
        ...options.env,
        // Ensure Claude Code gets a proper terminal
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  async stop(): Promise<void> {
    this.pty?.kill('SIGTERM');
    // Wait for exit with timeout, then SIGKILL if needed
  }

  kill(): void {
    this.pty?.kill('SIGKILL');
  }

  onData(callback: (data: string) => void): void {
    this.pty?.onData(callback);
  }

  onExit(callback: (exitInfo: { exitCode: number }) => void): void {
    this.pty?.onExit(({ exitCode }) => callback({ exitCode }));
  }
}
```

### Environment Variables

The local adapter merges env vars in this priority order (highest wins):

1. Session-level `api_config` overrides
2. Environment-level `api_config` defaults
3. App-level default API config
4. User's shell environment (`process.env`)

The critical env vars for OpenRouter:

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_API_KEY=sk-or-...
ANTHROPIC_MODEL=anthropic/claude-sonnet-4       (optional)
ANTHROPIC_SMALL_FAST_MODEL=anthropic/claude-haiku-4.5  (optional)
```

### PTY Lifecycle

- **Spawn:** `node-pty.spawn()` creates a child process with a pseudo-terminal.
- **The PTY lives in the Electron main process.** If the renderer crashes and restarts, the PTY is still alive. The renderer reconnects by re-attaching the xterm.js instance to the existing data stream.
- **Exit:** When Claude Code exits (user types `/exit`, process completes, crash), `onExit` fires with the exit code. The transport is now inert — `write()` and `resize()` become no-ops.
- **Orphan cleanup:** On app startup, the session registry is scanned for sessions in `running`/`waiting`/`idle` state. If the app PID file shows a different PID than the current process (meaning previous crash), those sessions are marked `dead` and their PIDs are checked for zombie processes to kill.

## SSH Adapter

### Implementation

Uses the `ssh2` npm package for SSH connectivity.

```typescript
// Conceptual implementation — not final code

class SSHTransport implements SessionTransport {
  private client: Client | null = null;
  private stream: ClientChannel | null = null;

  async start(options: TransportStartOptions): Promise<void> {
    this.client = new Client();

    await new Promise<void>((resolve, reject) => {
      this.client.on('ready', () => {
        this.client.shell(
          {
            term: 'xterm-256color',
            cols: options.cols,
            rows: options.rows,
          },
          (err, stream) => {
            if (err) return reject(err);
            this.stream = stream;

            // Send the command to start Claude Code
            // We use the shell channel and send the command as input
            // so that the user's remote shell profile is sourced
            const envExports = Object.entries(options.env)
              .map(([k, v]) => `export ${k}="${v}"`)
              .join(' && ');

            const cmd = options.cliArgs?.length
              ? `claude ${options.cliArgs.join(' ')}`
              : 'claude';

            stream.write(`${envExports} && cd ${options.workingDir} && ${cmd}\n`);

            resolve();
          }
        );
      });

      this.client.on('error', reject);

      this.client.connect({
        host: options.sshConfig.host,
        port: options.sshConfig.port || 22,
        username: options.sshConfig.user,
        privateKey: readFileSync(options.sshConfig.keyPath),
        // Or use agent: process.env.SSH_AUTH_SOCK
      });
    });
  }

  write(data: string): void {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  // ... stop, kill, onData, onExit follow same pattern
}
```

### Connection Management

**Initial connection:** SSH handshake → authenticate → open shell channel with PTY → send env exports and `claude` command.

**Keep-alive:** The `ssh2` client supports server keep-alive. Configured with `keepaliveInterval: 10000` (10s) and `keepaliveCountMax: 3` (drop after 30s of no response).

**Reconnection strategy:**
- On SSH channel close or connection error, mark session as `dead`
- User can manually trigger reconnect from the sidebar context menu
- On reconnect: re-establish SSH connection, open new shell, start new Claude Code process
- Note: this does NOT resume the Claude Code conversation. It's a fresh Claude Code session in the same directory. True session resume (using Claude Code's `--resume` flag) is a post-MVP feature.

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

## Container Adapter (Post-MVP Design Notes)

### Docker

```typescript
class DockerTransport implements SessionTransport {
  // Uses dockerode library
  // 1. Create container (or start existing) with Claude Code image
  // 2. Exec with PTY: container.exec({ Tty: true, AttachStdin: true, ... })
  // 3. Stream attach for data flow
  // Resize via exec.resize()
}
```

### Coder

```typescript
class CoderTransport implements SessionTransport {
  // Uses Coder API (REST)
  // 1. Create workspace from template (or start existing)
  // 2. Open terminal session via Coder's WebSocket terminal API
  // 3. Data flows over WebSocket
  // Resize via WebSocket control message
}
```

Both follow the same `SessionTransport` interface. The terminal panel is completely unaware of which adapter is active.

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
