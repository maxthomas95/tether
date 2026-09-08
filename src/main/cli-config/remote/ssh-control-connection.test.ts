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
