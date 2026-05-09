import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ssh2Harness = vi.hoisted(() => {
  // EventEmitter must be required inside the hoisted block — vi.hoisted runs
  // before any static `import` resolves.
  const { EventEmitter } = require('node:events');
  type ShellCb = (err: Error | undefined, stream: NodeJS.ReadWriteStream) => void;

  class FakeStream extends EventEmitter {
    write = vi.fn();
    setWindow = vi.fn();
    emitData(buf: Buffer | string) {
      this.emit('data', typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf);
    }
    emitClose() { this.emit('close'); }
  }

  class FakeClient extends EventEmitter {
    connect = vi.fn();
    end = vi.fn();
    destroy = vi.fn();
    shell = vi.fn((_opts: unknown, cb: ShellCb) => {
      this.lastShellCb = cb;
    });
    lastShellCb: ShellCb | null = null;
    constructor() { super(); current = this; }
  }

  let current: FakeClient | null = null;

  return {
    Client: FakeClient,
    FakeStream,
    get current(): FakeClient | null { return current; },
    reset() { current = null; },
  };
});

const verifyHostMock = vi.hoisted(() => vi.fn());

vi.mock('./ssh2-loader', () => ({
  loadSsh2: () => ({ Client: ssh2Harness.Client }),
}));

vi.mock('../ssh/host-verifier', () => ({
  verifyHost: verifyHostMock,
}));

import { SSHTransport, type SSHConfig } from './ssh-transport';
import type { TransportStartOptions } from './types';

function baseConfig(overrides: Partial<SSHConfig> = {}): SSHConfig {
  return {
    host: '10.0.0.1',
    port: 22,
    username: 'me',
    password: 'pw',
    ...overrides,
  };
}

function baseOptions(overrides: Partial<TransportStartOptions> = {}): TransportStartOptions {
  return {
    workingDir: '/home/me/repo',
    env: {},
    cols: 80,
    rows: 24,
    cliArgs: [],
    cliTool: 'claude',
    binaryName: 'claude',
    ...overrides,
  };
}

/**
 * Drive the post-connect handshake to completion: emits a shell prompt so
 * the setup state machine moves through `waitShell -> waitEchoOff -> done`.
 */
function driveSetupToCompletion(stream: InstanceType<typeof ssh2Harness.FakeStream>) {
  // First prompt → triggers `stty -echo`
  stream.emitData('user@host:~$ ');
  // Second prompt → triggers final command write + resolve()
  stream.emitData('user@host:~$ ');
}

describe('SSHTransport', () => {
  beforeEach(() => {
    ssh2Harness.reset();
    verifyHostMock.mockReset();
    verifyHostMock.mockResolvedValue({ trust: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports not connected before start', () => {
    expect(new SSHTransport(baseConfig()).connected).toBe(false);
  });

  it('passes username / port / keepalives to ssh2.connect', async () => {
    const t = new SSHTransport(baseConfig({ host: 'host.example', port: 2222, username: 'alice' }));
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    const cfg = client.connect.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.host).toBe('host.example');
    expect(cfg.port).toBe(2222);
    expect(cfg.username).toBe('alice');
    expect(cfg.keepaliveInterval).toBe(10000);
    expect(cfg.readyTimeout).toBe(15000);
  });

  it('uses agent path when useAgent is set', async () => {
    const t = new SSHTransport(baseConfig({ useAgent: true, password: undefined }));
    delete process.env.SSH_AUTH_SOCK;
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    const cfg = client.connect.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.agent).toBeDefined();
    expect(cfg.privateKey).toBeUndefined();
    expect(cfg.password).toBeUndefined();
  });

  it('falls back to password auth when no agent / key configured', async () => {
    const t = new SSHTransport(baseConfig({ password: 'secret' }));
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    const cfg = client.connect.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.password).toBe('secret');
    expect(cfg.privateKey).toBeUndefined();
  });

  it('rejects when private key file is unreadable', async () => {
    const t = new SSHTransport(baseConfig({
      privateKeyPath: '/nonexistent/path/id_rsa',
      password: undefined,
    }));
    await expect(t.start(baseOptions())).rejects.toThrow(/Failed to read SSH key/);
  });

  it('rejects when shell() callback errors', async () => {
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    client.lastShellCb!(new Error('shell failed'), null as unknown as NodeJS.ReadWriteStream);
    await expect(start).rejects.toThrow(/shell failed/);
  });

  it('host verifier rejection surfaces a friendly error on connection error', async () => {
    verifyHostMock.mockResolvedValue({ trust: false, reason: 'Host key changed' });
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;

    // Trigger the host verifier path
    const cfg = client.connect.mock.calls[0][0] as { hostVerifier: (k: string, cb: (b: boolean) => void) => void };
    const verifyResult = await new Promise<boolean>((resolve) => {
      cfg.hostVerifier('abcd1234', resolve);
    });
    expect(verifyResult).toBe(false);

    client.emit('error', new Error('handshake failed'));
    await expect(start).rejects.toThrow(/Host key changed/);
  });

  it('builds the launch command with cd + env + binary + initialPrompt', async () => {
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions({
      workingDir: '/srv/app',
      env: { FOO: 'bar' },
      cliArgs: ['--model', 'sonnet'],
      initialPrompt: "what's up",
      binaryName: 'claude',
    }));
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    // Final write is the launch command
    const writes = stream.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain('cd /srv/app');
    expect(writes).toContain('env FOO=bar');
    expect(writes).toContain('claude --model sonnet');
    expect(writes).toContain(`'what'\\''s up'`);
  });

  it('write delegates to the stream when started', async () => {
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    t.write('user input');
    // last write should be 'user input' (writes also include the launch cmd)
    expect(stream.write).toHaveBeenCalledWith('user input');
  });

  it('resize calls setWindow with rows-then-cols ordering', async () => {
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    t.resize(132, 50);
    expect(stream.setWindow).toHaveBeenCalledWith(50, 132, 0, 0);
  });

  it('kill destroys client, nulls stream/client, flips connected', async () => {
    const t = new SSHTransport(baseConfig());
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    expect(t.connected).toBe(true);
    t.kill();
    expect(client.destroy).toHaveBeenCalled();
    expect(t.connected).toBe(false);
  });

  it('fans data through onData listeners with multi-byte UTF-8 safety', async () => {
    const t = new SSHTransport(baseConfig());
    const dataCb = vi.fn();
    t.onData(dataCb);
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;
    dataCb.mockClear();

    // Emit a multi-byte glyph split across two writes ("é" = C3 A9).
    stream.emitData(Buffer.from([0xc3]));
    stream.emitData(Buffer.from([0xa9]));
    const combined = dataCb.mock.calls.map((c) => c[0]).join('');
    expect(combined).toBe('é');
  });

  it('stream close emits an exit info to onExit listeners', async () => {
    const t = new SSHTransport(baseConfig());
    const exitCb = vi.fn();
    t.onExit(exitCb);
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    stream.emitClose();
    expect(exitCb).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0 }));
    expect(t.connected).toBe(false);
  });

  it('dispose clears callbacks so subsequent events are no-ops', async () => {
    const t = new SSHTransport(baseConfig());
    const dataCb = vi.fn();
    const exitCb = vi.fn();
    t.onData(dataCb);
    t.onExit(exitCb);
    const start = t.start(baseOptions());
    const client = ssh2Harness.current!;
    client.emit('ready');
    const stream = new ssh2Harness.FakeStream();
    client.lastShellCb!(undefined, stream);
    driveSetupToCompletion(stream);
    await start;

    // Setup-phase prompts emitted via driveSetupToCompletion also reach the
    // dataCb (the listener is wired before setup runs). Clear before asserting.
    dataCb.mockClear();
    t.dispose();
    stream.emitData(Buffer.from('after dispose'));
    stream.emitClose();
    expect(dataCb).not.toHaveBeenCalled();
    expect(exitCb).not.toHaveBeenCalled();
  });
});
