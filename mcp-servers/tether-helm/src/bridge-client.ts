import net from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * Thin RPC client that dials Tether's per-session helm bridge and issues
 * method calls over a line-delimited JSON protocol. Authentication is the
 * first frame; all subsequent calls fail until auth succeeds.
 *
 * See `src/main/helm/bridge.ts` in the Tether repo for the server side.
 */

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class BridgeClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private readonly pending = new Map<string, PendingCall>();
  private connected = false;

  async connect(socketPath: string, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.off('error', reject);
        this.socket = sock;
        this.connected = true;
        this.wireSocket(sock);
        resolve();
      });
    });

    const result = await this.call('authenticate', { token });
    if (!result || typeof result !== 'object' || !(result as { ok?: unknown }).ok) {
      throw new Error('Helm bridge authentication failed');
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error('Bridge not connected');
    }
    const id = method === 'authenticate' ? 'auth' : randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.connected = false;
    if (this.socket) {
      try { this.socket.end(); } catch { /* already closed */ }
      this.socket = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('Bridge disposed'));
    }
    this.pending.clear();
  }

  private wireSocket(sock: net.Socket): void {
    sock.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let nl = this.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handleFrame(line);
        nl = this.buffer.indexOf('\n');
      }
    });

    sock.on('close', () => {
      this.connected = false;
      for (const { reject } of this.pending.values()) {
        reject(new Error('Bridge closed'));
      }
      this.pending.clear();
    });

    sock.on('error', (err) => {
      // Socket errors are surfaced via the close handler's pending-rejections.
      // Log to stderr so it shows up in Claude Code's MCP diagnostics.
      process.stderr.write(`[tether-helm] bridge socket error: ${err.message}\n`);
    });
  }

  private handleFrame(raw: string): void {
    let frame: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      frame = JSON.parse(raw);
    } catch {
      process.stderr.write(`[tether-helm] unparseable bridge frame: ${raw}\n`);
      return;
    }
    if (typeof frame.id !== 'string') return;
    const waiting = this.pending.get(frame.id);
    if (!waiting) return;
    this.pending.delete(frame.id);
    if (frame.error) {
      waiting.reject(new Error(frame.error.message || 'Bridge error'));
    } else {
      waiting.resolve(frame.result);
    }
  }
}
