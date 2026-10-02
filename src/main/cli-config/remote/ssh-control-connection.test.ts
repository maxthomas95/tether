import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Server, type Connection } from 'ssh2';
import type { AddressInfo } from 'node:net';
import { connectSshControl } from './ssh-control-connection';

vi.mock('../../transport/ssh-connect-config', () => ({ buildSshConnectConfig: (config: unknown) => config }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
let server: Server;
const clients: Connection[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

async function serve(handler: (client: Connection) => void) {
  server = new Server({ hostKeys: [privateKey] }, client => {
    clients.push(client);
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => handler(client));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'fixture' };
}

describe('SSH control command lifecycle', () => {
  it('preserves split UTF-8 bytes and sends stdin on the command channel', async () => {
    const config = await serve(client => client.on('session', accept => {
      const session = accept();
      session.on('exec', acceptExec => {
        const stream = acceptExec();
        let input = '';
        stream.on('data', (data: Buffer) => { input += data.toString(); });
        stream.on('end', () => {
          expect(input).toBe('stdin-value\n');
          const data = Buffer.from('模型🍁');
          stream.write(data.subarray(0, 2));
          setTimeout(() => { stream.write(data.subarray(2)); stream.exit(0); stream.end(); }, 5);
        });
      });
    }));
    const connection = await connectSshControl(config);
    try {
      const result = await connection.exec('probe', { input: 'stdin-value\n' });
      expect(result).toEqual({ code: 0, stdout: '模型🍁', stderr: '' });
    } finally { connection.end(); }
  });

  it('times out a hung command and rejects an already cancelled connection', async () => {
    const config = await serve(client => client.on('session', accept => {
      accept().on('exec', acceptExec => { acceptExec(); });
    }));
    const connection = await connectSshControl(config);
    try { await expect(connection.exec('hang', { timeoutMs: 30 })).rejects.toThrow('timed out'); }
    finally { connection.end(); }
    const abort = new AbortController();
    abort.abort();
    await expect(connectSshControl(config, abort.signal)).rejects.toThrow('cancelled');
  });
});

describe('SSH control resident process', () => {
  /** Polls until the condition holds, so no assertion races a slow channel. */
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condition not reached before timeout');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** Accepts one exec, hands the test the server side of its channel. */
  async function residentHost() {
    let stream: import('ssh2').ServerChannel | undefined;
    let stdin = '';
    const config = await serve(client => client.on('session', accept => {
      accept().on('exec', acceptExec => {
        stream = acceptExec();
        stream.on('data', (d: Buffer) => { stdin += d.toString(); });
      });
    }));
    return {
      config, until,
      stdin: () => stdin,
      ready: async () => { await until(() => !!stream); return stream!; },
    };
  }

  it('splits stdout into lines across chunks, keeps split UTF-8 intact, and fans out to every subscriber', async () => {
    const host = await residentHost();
    const connection = await connectSshControl(host.config);
    try {
      const probe = await connection.spawn('resident');
      const first: string[] = [];
      const second: string[] = [];
      probe.onLine(l => first.push(l));
      probe.onLine(l => second.push(l));

      probe.write('request-one\n');
      const stream = await host.ready();
      await until(() => host.stdin() === 'request-one\n');

      // A line arriving in three chunks, the middle one ending inside the
      // 4-byte leaf character, and no newline until the last.
      const payload = Buffer.from('__TETHER_USAGE__{"id":1,"path":"\u{1F341}"}\nsecond-line\n');
      stream.write(payload.subarray(0, 20));
      stream.write(payload.subarray(20, 34));
      await until(() => host.stdin() === 'request-one\n');
      expect(first).toEqual([]);
      stream.write(payload.subarray(34));
      await until(() => first.length >= 2);

      expect(first).toEqual(['__TETHER_USAGE__{"id":1,"path":"\u{1F341}"}', 'second-line']);
      expect(second).toEqual(first);
    } finally { connection.end(); }
  });

  it('reports exit once, however the channel ends, and answers a late subscriber immediately', async () => {
    const host = await residentHost();
    const connection = await connectSshControl(host.config);
    const probe = await connection.spawn('resident');
    let exits = 0;
    const exited = new Promise<void>(resolve => probe.onExit(() => { exits++; resolve(); }));
    const stream = await host.ready();
    stream.stderr.write('a remote secret that must not surface');
    // Both a clean exit and the channel closing land on the same observer.
    stream.exit(1);
    stream.end();
    await exited;
    expect(exits).toBe(1);

    let late = 0;
    probe.onExit(() => { late++; });
    expect(late).toBe(1);
    probe.kill();
    expect(exits).toBe(1);
    connection.end();
  });

  it('gives up on a remote that streams without ever ending a line', async () => {
    const host = await residentHost();
    const connection = await connectSshControl(host.config);
    try {
      const probe = await connection.spawn('resident', { maxLineBytes: 64 });
      const lines: string[] = [];
      probe.onLine(l => lines.push(l));
      const exited = new Promise<void>(resolve => probe.onExit(resolve));
      const stream = await host.ready();
      stream.write('x'.repeat(200));
      await exited;
      expect(lines).toEqual([]);
      // Writing to a dead channel is absorbed rather than thrown at the caller.
      expect(() => probe.write('ignored\n')).not.toThrow();
    } finally { connection.end(); }
  });

  it('fires exit when the whole connection drops under a live process', async () => {
    const host = await residentHost();
    const connection = await connectSshControl(host.config);
    const probe = await connection.spawn('resident');
    const exited = new Promise<void>(resolve => probe.onExit(resolve));
    await host.ready();
    connection.end();
    await exited;
  });
});
