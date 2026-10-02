import { CLI_TOOL_REGISTRY } from '../../shared/cli-tools';
import type { CliMaintenanceRequest, CliMaintenanceRun } from '../../shared/cli-maintenance';
import type { SessionTransport, TransportExitInfo } from '../transport/types';

export interface MaintenanceTarget {
  key: string;
  workingDir: string;
  windows: boolean;
  env(): Promise<Record<string, string>>;
  transport(): Promise<SessionTransport>;
}

interface ActiveRun {
  info: CliMaintenanceRun;
  target: MaintenanceTarget;
  request: CliMaintenanceRequest;
  transport?: SessionTransport;
  abort?: () => void;
  cols: number;
  rows: number;
}

export function validateMaintenanceRequest(value: unknown): CliMaintenanceRequest {
  if (!value || typeof value !== 'object') throw new Error('Choose a CLI and environment.');
  const r = value as CliMaintenanceRequest;
  if (typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(r.id)) throw new Error('Invalid maintenance request id.');
  if (!['claude', 'codex', 'opencode'].includes(r.tool)) throw new Error('This CLI does not support updates in Tether.');
  if (r.action !== 'check' && r.action !== 'update') throw new Error('Invalid maintenance action.');
  if (!CLI_TOOL_REGISTRY[r.tool].maintenance?.methods.some(m => m.id === r.method)) throw new Error('Choose a supported update method.');
  for (const key of ['environmentId', 'sessionId', 'workspace'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'string' || !r[key] || r[key]!.length > 300 || /[\x00-\x1f]/.test(r[key]!))) {
      throw new Error(`Invalid maintenance ${key}.`);
    }
  }
  for (const key of ['cols', 'rows'] as const) {
    if (r[key] !== undefined && (!Number.isInteger(r[key]) || r[key]! < 2 || r[key]! > 500)) throw new Error('Invalid terminal size.');
  }
  // Only copy recognized fields; the renderer cannot supply executable paths, argv or env.
  return { id: r.id, tool: r.tool, action: r.action, method: r.method,
    environmentId: r.environmentId, sessionId: r.sessionId, workspace: r.workspace, cols: r.cols, rows: r.rows };
}

/** Independent of agent sessions: no detector, hooks, persistence, telemetry or PTY parsing. */
export class MaintenanceManager {
  private runs = new Map<string, ActiveRun>();

  constructor(
    private readonly targetFor: (request: CliMaintenanceRequest) => MaintenanceTarget,
    private readonly onData: (id: string, phase: CliMaintenanceRun['phase'], data: string) => void,
    private readonly onChanged: (run: CliMaintenanceRun) => void,
  ) {}

  start(value: unknown): CliMaintenanceRun {
    const request = validateMaintenanceRequest(value);
    const target = this.targetFor(request);
    if (request.method === 'winget' && !target.windows) throw new Error('WinGet updates require a local Windows environment.');
    if (request.method.startsWith('brew') && target.windows) throw new Error('Homebrew updates require a macOS or Linux environment.');
    if (this.runs.has(request.id) || [...this.runs.values()].some(r => r.target.key === target.key && r.request.tool === request.tool)) {
      throw new Error('Maintenance is already running for this CLI on this target.');
    }
    const run: ActiveRun = { info: { id: request.id, status: 'running', phase: 'locate' }, target, request,
      cols: request.cols ?? 100, rows: request.rows ?? 24 };
    this.runs.set(request.id, run);
    const initial = { ...run.info };
    void this.execute(run);
    return initial;
  }

  private publish(run: ActiveRun, changes: Partial<CliMaintenanceRun>): void {
    Object.assign(run.info, changes);
    this.onChanged({ ...run.info });
  }

  private async execute(run: ActiveRun): Promise<void> {
    try {
      const env = await run.target.env();
      if (run.info.status !== 'running') return;
      const binary = CLI_TOOL_REGISTRY[run.request.tool].binaryName;
      // Path discovery is its own read-only command, shown verbatim in the terminal.
      const locate = run.target.windows
        ? { file: 'where.exe', args: [binary] }
        : { file: 'sh', args: ['-c', `command -v ${binary}`] };
      for (const [phase, command] of [
        ['locate', locate], ['before', { file: binary, args: ['--version'] }],
      ] as const) {
        const result = await this.command(run, phase, command, env);
        if (result.exitCode !== 0) throw new Error(`${phase === 'locate' ? 'CLI path lookup' : 'Version check'} failed (exit ${result.exitCode}). Check the terminal output.`);
      }
      if (run.request.action === 'check') {
        this.publish(run, { status: 'completed', exitCode: 0 });
        return;
      }
      const method = CLI_TOOL_REGISTRY[run.request.tool].maintenance!.methods.find(m => m.id === run.request.method)!;
      const updated = await this.command(run, 'update', { file: method.file, args: method.args }, env);
      // Always check the executable again, including when the updater reports failure.
      const verified = await this.command(run, 'after', { file: binary, args: ['--version'] }, env);
      const code = updated.exitCode || verified.exitCode;
      this.publish(run, code === 0
        ? { status: 'completed', exitCode: 0 }
        : { status: 'failed', exitCode: code, error: 'Update or verification failed. Check the terminal output.' });
    } catch (err) {
      if (run.info.status === 'running') this.publish(run, { status: 'failed', error: err instanceof Error ? err.message : 'Maintenance failed.' });
    } finally {
      run.transport?.dispose();
      if (this.runs.get(run.request.id) === run) this.runs.delete(run.request.id);
    }
  }

  private async command(run: ActiveRun, phase: CliMaintenanceRun['phase'], command: { file: string; args: readonly string[] }, env: Record<string, string>): Promise<TransportExitInfo> {
    if (run.info.status !== 'running') throw new Error('Maintenance cancelled.');
    const transport = await run.target.transport();
    if (run.info.status !== 'running') { transport.dispose(); throw new Error('Maintenance cancelled.'); }
    run.transport = transport;
    this.publish(run, { phase });
    try {
      return await new Promise<TransportExitInfo>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, result?: TransportExitInfo) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          run.abort = undefined;
          if (error) reject(error);
          else resolve(result!);
        };
        const timer = setTimeout(() => finish(new Error('Maintenance command timed out.')), phase === 'update' ? 10 * 60_000 : 30_000);
        run.abort = () => finish(new Error('Maintenance cancelled.'));
        transport.onData(data => { if (!settled && run.info.status === 'running') this.onData(run.request.id, phase, data); });
        transport.onExit(info => finish(undefined, info));
        // Exact argv bypasses conversation flag presets, resume arguments and hooks.
        void transport.start({ workingDir: run.target.workingDir, env, cols: run.cols, rows: run.rows,
          cliTool: 'custom', command: { file: command.file, args: [...command.args] }, exitAfterCommand: true,
        }).then(() => {
          if (settled || run.info.status !== 'running') transport.dispose();
        }).catch(err => finish(err instanceof Error ? err : new Error('Command could not start.')));
      });
    } finally {
      transport.dispose();
      if (run.transport === transport) run.transport = undefined;
    }
  }

  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.info.status !== 'running') return;
    this.publish(run, { status: 'cancelled' });
    run.abort?.();
    run.transport?.dispose();
    this.runs.delete(id);
  }

  input(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 16_384) return;
    this.runs.get(id)?.transport?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (![cols, rows].every(n => Number.isInteger(n) && n >= 2 && n <= 500)) return;
    const run = this.runs.get(id);
    if (!run) return;
    run.cols = cols;
    run.rows = rows;
    run.transport?.resize(cols, rows);
  }

  dispose(): void { for (const id of this.runs.keys()) this.cancel(id); }
}
