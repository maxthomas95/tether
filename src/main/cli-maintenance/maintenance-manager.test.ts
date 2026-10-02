import { describe, it, expect, vi } from 'vitest';
import { MaintenanceManager, validateMaintenanceRequest, type MaintenanceTarget } from './maintenance-manager';
import type { CliMaintenanceRequest, CliMaintenanceRun } from '../../shared/cli-maintenance';
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from '../transport/types';

const request = (overrides: Partial<CliMaintenanceRequest> = {}): CliMaintenanceRequest => ({
  id: '11111111-1111-4111-a111-111111111111', tool: 'codex', action: 'update', method: 'native', ...overrides,
});

class FakeTransport implements SessionTransport {
  connected = true;
  data: (data: string) => void = () => {};
  exit: (info: TransportExitInfo) => void = () => {};
  write = vi.fn(); resize = vi.fn(); kill = vi.fn(); stop = vi.fn(async () => {}); dispose = vi.fn();
  constructor(private readonly code: number | null, private readonly options: TransportStartOptions[], private readonly bytes: string) {}
  async start(options: TransportStartOptions) {
    this.options.push(options);
    this.data(this.bytes);
    if (this.code !== null) queueMicrotask(() => this.exit({ exitCode: this.code! }));
  }
  onData(cb: (data: string) => void) { this.data = cb; }
  onExit(cb: (info: TransportExitInfo) => void) { this.exit = cb; }
}

function harness(codes: (number | null)[] = [0, 0, 0, 0], extra: Partial<MaintenanceTarget> = {}) {
  const options: TransportStartOptions[] = [];
  const transports: FakeTransport[] = [];
  const changed: CliMaintenanceRun[] = [];
  const onData = vi.fn();
  const target: MaintenanceTarget = { key: 'ssh:host', workingDir: '/repo with spaces', windows: false,
    env: async () => ({ CODEX_HOME: '/custom home', PATH: '/trusted/bin' }),
    transport: async () => {
      const t = new FakeTransport(codes[transports.length] ?? null, options, '\x1b[31m原始\r\n');
      transports.push(t); return t;
    }, ...extra };
  const manager = new MaintenanceManager(() => target, onData, run => changed.push(run));
  return { manager, options, transports, changed, onData };
}

async function completed(changed: CliMaintenanceRun[]) {
  await vi.waitFor(() => expect(changed.at(-1)?.status !== undefined && changed.at(-1)?.status !== 'running').toBe(true));
  expect(changed.length).toBeGreaterThan(0);
}

describe('CLI maintenance runner', () => {
  it.each(['codex', 'claude', 'opencode'] as const)('updates %s with exact argv and verifies afterward', async tool => {
    const h = harness();
    h.manager.start(request({ tool }));
    await completed(h.changed);
    expect(h.options.map(o => o.command)).toEqual([
      { file: 'sh', args: ['-c', `command -v ${tool}`] },
      { file: tool, args: ['--version'] },
      { file: tool, args: [tool === 'opencode' ? 'upgrade' : 'update'] },
      { file: tool, args: ['--version'] },
    ]);
    for (const options of h.options) {
      expect(options).toMatchObject({ workingDir: '/repo with spaces', cliTool: 'custom', exitAfterCommand: true,
        env: { CODEX_HOME: '/custom home', PATH: '/trusted/bin' } });
      expect(options.cliArgs).toBeUndefined();
      expect(options.resumeToolSessionId).toBeUndefined();
    }
    expect(h.onData.mock.calls.every(([, , bytes]) => bytes === '\x1b[31m原始\r\n')).toBe(true);
    expect(h.changed.at(-1)).toMatchObject({ status: 'completed', phase: 'after', exitCode: 0 });
    expect(h.transports.every(t => t.dispose.mock.calls.length > 0)).toBe(true);
  });

  it('check version never runs an updater', async () => {
    const h = harness(); h.manager.start(request({ action: 'check' })); await completed(h.changed);
    expect(h.options).toHaveLength(2);
    expect(h.changed.at(-1)).toMatchObject({ status: 'completed', phase: 'before' });
  });

  it('keeps updater failure even when the final version command succeeds', async () => {
    const h = harness([0, 0, 17, 0]); h.manager.start(request()); await completed(h.changed);
    expect(h.options).toHaveLength(4);
    expect(h.changed.at(-1)).toMatchObject({ status: 'failed', exitCode: 17 });
  });

  it('fails final verification and stops before updating an unavailable CLI', async () => {
    for (const codes of [[0, 0, 0, 7], [1], [0, 2]]) {
      const h = harness(codes); h.manager.start(request()); await completed(h.changed);
      expect(h.changed.at(-1)?.status).toBe('failed');
      expect(h.options.length).toBe(codes.length);
    }
  });

  it('locks one tool per target, forwards interaction, and cancels without launching the updater', async () => {
    const h = harness([0, null]); h.manager.start(request());
    await vi.waitFor(() => expect(h.options).toHaveLength(2));
    expect(() => h.manager.start(request({ id: '22222222-2222-4222-a222-222222222222' }))).toThrow('already running');
    h.manager.input(request().id, '\r'); h.manager.resize(request().id, 90, 30);
    expect(h.transports[1].write).toHaveBeenCalledWith('\r');
    expect(h.transports[1].resize).toHaveBeenCalledWith(90, 30);
    h.manager.cancel(request().id); await completed(h.changed);
    h.transports[1].data('late output'); h.transports[1].exit({ exitCode: 0 });
    expect(h.changed.at(-1)?.status).toBe('cancelled');
    expect(h.options).toHaveLength(2);
    expect(h.onData).toHaveBeenCalledTimes(2);
  });

  it('cancels while environment resolution or transport creation is pending', async () => {
    let resolveEnv!: (env: Record<string, string>) => void;
    const h = harness([], { env: () => new Promise(resolve => { resolveEnv = resolve; }) });
    h.manager.start(request()); h.manager.cancel(request().id); resolveEnv({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.transports).toHaveLength(0);
    let resolveTransport!: (transport: SessionTransport) => void;
    const t = new FakeTransport(null, [], '');
    const pending = harness([], { transport: () => new Promise(resolve => { resolveTransport = resolve; }) });
    pending.manager.start(request());
    await vi.waitFor(() => expect(resolveTransport).toBeDefined());
    pending.manager.dispose(); resolveTransport(t);
    await vi.waitFor(() => expect(t.dispose).toHaveBeenCalled());
    expect(pending.options).toHaveLength(0);
  });

  it('bounds hung commands and releases the target after timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = harness([null]); h.manager.start(request());
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.changed.at(-1)).toMatchObject({ status: 'failed', error: 'Maintenance command timed out.' });
      expect(h.transports[0].dispose).toHaveBeenCalled();
      expect(() => h.manager.start(request())).not.toThrow();
      h.manager.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('offers explicit package-manager fallbacks without accepting arbitrary commands', async () => {
    const h = harness(); h.manager.start(request({ method: 'npm' })); await completed(h.changed);
    expect(h.options[2].command).toEqual({ file: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
    expect(() => harness().manager.start(request({ tool: 'claude', method: 'winget' }))).toThrow('Windows');
    expect(() => harness([], { windows: true }).manager.start(request({ method: 'brew' }))).toThrow('Homebrew');
    expect(validateMaintenanceRequest({ ...request(), command: 'danger', env: { secret: 'value' } })).not.toHaveProperty('command');
    for (const overrides of [{ tool: 'custom' }, { method: 'custom' }, { id: '../bad' }, { action: 'delete' }, { workspace: 'a\nb' }, { cols: 0 }]) {
      expect(() => validateMaintenanceRequest({ ...request(), ...overrides })).toThrow();
    }
  });
});
