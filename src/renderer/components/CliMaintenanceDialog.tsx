import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CLI_TOOL_REGISTRY, type MaintainableCliTool, type CliUpdateMethod } from '../../shared/cli-tools';
import type { CliMaintenanceRun } from '../../shared/cli-maintenance';
import type { CoderWorkspace, EnvironmentInfo, SessionInfo } from '../../shared/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { extractErrorMessage } from '../utils/errors';
import '../styles/cli-maintenance.css';

const TOOLS: MaintainableCliTool[] = ['codex', 'claude', 'opencode'];
const PHASES = { locate: 'Locating executable', before: 'Checking installed version', update: 'Running updater', after: 'Verifying installed version' };
type Phase = CliMaintenanceRun['phase'];
const OUTPUT_LABELS: Record<Phase, string> = { locate: 'Executable path', before: 'Version before', update: 'Updater', after: 'Version after' };
const PHASE_IDS = Object.keys(PHASES) as Phase[];

interface Props {
  environments: EnvironmentInfo[];
  sessions: SessionInfo[];
  initialEnvironmentId?: string;
  initialSessionId?: string;
  theme: ITheme;
  onClose(): void;
}

export function CliMaintenanceDialog({ environments, sessions, initialEnvironmentId, initialSessionId, theme, onClose }: Props) {
  const initialSession = sessions.find(s => s.id === initialSessionId);
  const [tool, setTool] = useState<MaintainableCliTool>(TOOLS.includes(initialSession?.cliTool as MaintainableCliTool) ? initialSession!.cliTool as MaintainableCliTool : initialSession?.cliTool === undefined && initialSession ? 'claude' : 'codex');
  const [target, setTarget] = useState(initialSessionId ? `session:${initialSessionId}` : `env:${initialEnvironmentId ?? ''}`);
  const [method, setMethod] = useState<CliUpdateMethod>('native');
  const [workspace, setWorkspace] = useState('');
  const [workspaces, setWorkspaces] = useState<CoderWorkspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState('');
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [run, setRun] = useState<CliMaintenanceRun | null>(null);
  const [shownPhase, setShownPhase] = useState<Phase>('locate');
  const [visitedPhases, setVisitedPhases] = useState<Set<Phase>>(new Set(['locate']));
  const dialogRef = useRef<HTMLDivElement>(null);
  const terminalContainers = useRef<Partial<Record<Phase, HTMLDivElement | null>>>({});
  const terminals = useRef<Partial<Record<Phase, { terminal: Terminal; fit: FitAddon }>>>({});
  const activePhase = useRef<Phase>('locate');
  const runId = useRef<string | null>(null);
  const running = useRef(false);
  const busy = run?.status === 'running';
  const sessionId = target.startsWith('session:') ? target.slice(8) : undefined;
  const session = sessions.find(s => s.id === sessionId);
  const environmentId = sessionId ? session?.environmentId ?? undefined : target.slice(4) || undefined;
  const environment = environments.find(e => e.id === environmentId);
  const coder = environment?.type === 'coder';
  const windows = (!environment || environment.type === 'local') && window.electronAPI.platform === 'win32';
  const methods = CLI_TOOL_REGISTRY[tool].maintenance!.methods.filter(m => m.id === 'winget' ? windows : m.id.startsWith('brew') ? !windows : true);
  const selectedMethod = methods.find(m => m.id === method) ?? methods[0];
  const targetName = session ? `${session.label} · ${environment?.name ?? 'Local PC'}` : environment?.name ?? 'Local PC';

  const close = useCallback(() => {
    if (runId.current) void window.electronAPI.cliMaintenance.cancel(runId.current).catch(() => {});
    onClose();
  }, [onClose]);
  useEscapeKey(close);
  useFocusTrap(dialogRef);

  useEffect(() => {
    setWorkspaces([]);
    setWorkspace('');
    setWorkspaceError('');
    setLoadingWorkspaces(false);
    if (!coder || sessionId || !environmentId) return;
    let disposed = false;
    setLoadingWorkspaces(true);
    void window.electronAPI.coder.listWorkspaces(environmentId).then(list => {
      if (!disposed) setWorkspaces(list);
    }).catch(err => {
      if (!disposed) setWorkspaceError(extractErrorMessage(err));
    }).finally(() => { if (!disposed) setLoadingWorkspaces(false); });
    return () => { disposed = true; };
  }, [coder, sessionId, environmentId]);

  useEffect(() => {
    const disposables: Array<{ dispose(): void }> = [];
    // Each command owns a terminal. ConPTY initialization can clear a screen;
    // retaining separate screens preserves earlier output without filtering bytes.
    for (const phase of PHASE_IDS) {
      const container = terminalContainers.current[phase];
      if (!container) continue;
      const term = new Terminal({ theme, fontSize: 13, scrollback: 10000,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono-terminal').trim() || 'monospace' });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      terminals.current[phase] = { terminal: term, fit };
      disposables.push(term.onData(data => {
        if (runId.current && running.current && activePhase.current === phase) window.electronAPI.cliMaintenance.input(runId.current, data);
      }));
    }
    const fitTerminal = () => {
      const entry = terminals.current[activePhase.current];
      if (!entry) return;
      entry.fit.fit();
      if (runId.current) window.electronAPI.cliMaintenance.resize(runId.current, entry.terminal.cols, entry.terminal.rows);
    };
    const resize = new ResizeObserver(fitTerminal);
    for (const container of Object.values(terminalContainers.current)) { if (container) resize.observe(container); }
    fitTerminal();
    const unsubscribeData = window.electronAPI.cliMaintenance.onData((id, phase, data) => {
      if (id === runId.current) terminals.current[phase]?.terminal.write(data);
    });
    const unsubscribeChanged = window.electronAPI.cliMaintenance.onChanged(info => {
      if (info.id !== runId.current) return;
      running.current = info.status === 'running';
      activePhase.current = info.phase;
      setShownPhase(info.phase);
      setVisitedPhases(current => new Set([...current, info.phase]));
      setRun(info);
    });
    return () => {
      if (runId.current) void window.electronAPI.cliMaintenance.cancel(runId.current).catch(() => {});
      unsubscribeData(); unsubscribeChanged(); resize.disconnect();
      for (const disposable of disposables) disposable.dispose();
      for (const entry of Object.values(terminals.current)) entry.terminal.dispose();
      terminals.current = {};
    };
    // The terminal is owned by this dialog. Theme changes do not recreate a live updater.
  }, []);

  useEffect(() => { for (const entry of Object.values(terminals.current)) entry.terminal.options.theme = theme; }, [theme]);
  useEffect(() => {
    activePhase.current = shownPhase;
    for (const phase of PHASE_IDS) {
      const textarea = terminals.current[phase]?.terminal.textarea;
      if (textarea) textarea.tabIndex = phase === shownPhase ? 0 : -1;
    }
    const entry = terminals.current[shownPhase];
    if (!entry) return;
    entry.fit.fit();
    if (runId.current && running.current) window.electronAPI.cliMaintenance.resize(runId.current, entry.terminal.cols, entry.terminal.rows);
  }, [shownPhase]);

  const resetOutput = () => {
    runId.current = null;
    running.current = false;
    for (const entry of Object.values(terminals.current)) entry.terminal.reset();
    setRun(null);
    setShownPhase('locate');
    setVisitedPhases(new Set(['locate']));
  };

  const start = async (action: 'check' | 'update') => {
    if (running.current) return;
    const id = crypto.randomUUID();
    runId.current = id;
    running.current = true;
    for (const entry of Object.values(terminals.current)) entry.terminal.reset();
    activePhase.current = 'locate';
    setShownPhase('locate');
    setVisitedPhases(new Set(['locate']));
    setRun({ id, status: 'running', phase: 'locate' });
    try {
      const initial = await window.electronAPI.cliMaintenance.start({ id, tool, action, method: selectedMethod.id,
        environmentId, sessionId, workspace: coder && !sessionId ? workspace : undefined,
        cols: terminals.current.locate?.terminal.cols, rows: terminals.current.locate?.terminal.rows });
      // A fast command can publish phase/completion events before invoke resolves.
      if (runId.current === id) setRun(current => current?.id === id ? current : initial);
    } catch (err) {
      if (runId.current === id) { running.current = false; setRun({ id, status: 'failed', phase: 'locate', error: extractErrorMessage(err) }); }
    }
  };
  const ready = !busy && !(sessionId && !session) && (!coder || !!sessionId || !!workspace);

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="dialog cli-maintenance-dialog" role="dialog" aria-modal="true" aria-labelledby="cli-maintenance-title">
        <div className="dialog-header"><h2 id="cli-maintenance-title">CLI tools</h2><button className="dialog-close" onClick={close} aria-label={busy ? 'Cancel maintenance and close' : 'Close CLI tools'}>×</button></div>
        <div className="dialog-body">
          <p className="form-hint">Check and update the CLI installed on a selected machine or workspace.</p>
          <div className="cli-maintenance-controls">
            <label className="form-label">CLI<select aria-label="CLI" className="form-select" value={tool} disabled={busy} onChange={e => { setTool(e.target.value as MaintainableCliTool); setMethod('native'); resetOutput(); }}>
              {TOOLS.map(id => <option key={id} value={id}>{CLI_TOOL_REGISTRY[id].displayName}</option>)}
            </select></label>
            <label className="form-label">Target<select aria-label="Target" className="form-select" value={target} disabled={busy} onChange={e => { setTarget(e.target.value); setMethod('native'); resetOutput(); }}>
              <optgroup label="Environments"><option value="env:">Local PC</option>{environments.map(e => <option key={e.id} value={`env:${e.id}`}>{e.name} ({e.type === 'ssh' ? 'SSH' : e.type === 'coder' ? 'Coder' : 'Local'})</option>)}</optgroup>
              {sessions.length > 0 && <optgroup label="Use a session’s launch environment">{sessions.map(s => <option key={s.id} value={`session:${s.id}`}>{s.label} · {environments.find(e => e.id === s.environmentId)?.name ?? 'Local PC'}</option>)}</optgroup>}
            </select></label>
            {coder && !sessionId && <label className="form-label">Coder workspace<select aria-label="Coder workspace" className="form-select" value={workspace} disabled={busy || loadingWorkspaces} onChange={e => { setWorkspace(e.target.value); resetOutput(); }}>
              <option value="">{loadingWorkspaces ? 'Loading workspaces…' : 'Choose a workspace'}</option>{workspaces.map(w => <option key={`${w.owner}/${w.name}`} value={`${w.owner}/${w.name}`}>{w.owner}/{w.name} ({w.status})</option>)}
            </select></label>}
            <label className="form-label">Update method<select aria-label="Update method" className="form-select" value={selectedMethod.id} disabled={busy} onChange={e => { setMethod(e.target.value as CliUpdateMethod); resetOutput(); }}>
              {methods.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select></label>
          </div>
          {workspaceError && <p role="alert" className="cli-maintenance-error">{workspaceError}</p>}
          <p className="form-hint">Target: <strong>{targetName}</strong>{coder ? ` · ${session?.workingDir.split('::')[0] ?? (workspace || 'workspace required')}` : ''}. {session ? 'Uses this session’s PATH and CLI home settings.' : 'Uses app and environment variables.'}</p>
          <p className="form-hint">Choose the method used to install this CLI. Updates can affect every session using that installation. Tool updaters use their existing settings; package-manager options use the indicated package or channel.</p>
          <div className="cli-maintenance-command"><span>Update command</span><code>{selectedMethod.file} {selectedMethod.args.join(' ')}</code></div>
          <div className="cli-maintenance-actions"><button className="form-btn" disabled={!ready} onClick={() => void start('check')}>Check version</button><button className="form-btn form-btn--primary" disabled={!ready} onClick={() => void start('update')}>Update {CLI_TOOL_REGISTRY[tool].displayName}</button>{busy && <button className="form-btn" onClick={() => { if (runId.current) void window.electronAPI.cliMaintenance.cancel(runId.current).catch(() => {}); }}>Cancel</button>}</div>
          <p className="cli-maintenance-status" role="status" aria-live="polite">{run?.status === 'running' ? `${PHASES[run.phase]}…` : run?.status === 'failed' ? run.error ?? `Command failed (exit ${run.exitCode}).` : run?.status === 'cancelled' ? 'Maintenance cancelled.' : run?.status === 'completed' ? 'Commands finished. Review the installed version in the terminal below.' : 'Ready. Version checks show the executable path and installed version.'}</p>
          <div className="cli-maintenance-output-tabs" role="tablist" aria-label="Maintenance command output" onKeyDown={e => {
            if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const phases = PHASE_IDS.filter(phase => visitedPhases.has(phase));
            const index = phases.indexOf(shownPhase);
            const next = e.key === 'Home' ? phases[0] : e.key === 'End' ? phases.at(-1)! : phases[(index + (e.key === 'ArrowRight' ? 1 : -1) + phases.length) % phases.length];
            setShownPhase(next);
            document.getElementById(`maintenance-tab-${next}`)?.focus();
          }}>
            {PHASE_IDS.filter(phase => visitedPhases.has(phase)).map(phase => <button key={phase} role="tab"
              id={`maintenance-tab-${phase}`} aria-selected={shownPhase === phase} aria-controls={`maintenance-output-${phase}`}
              className="form-btn" disabled={busy} tabIndex={shownPhase === phase ? 0 : -1} onClick={() => setShownPhase(phase)}>{OUTPUT_LABELS[phase]}</button>)}
          </div>
          {PHASE_IDS.map(phase => <div key={phase} id={`maintenance-output-${phase}`} role="tabpanel"
            aria-labelledby={`maintenance-tab-${phase}`} hidden={shownPhase !== phase}
            className="cli-maintenance-terminal" ref={el => { terminalContainers.current[phase] = el; }} />)}
          <p className="form-hint">Existing conversations keep running. After an update, restart or resume affected sessions when ready. If an executable is in use on Windows, stop those sessions and retry.</p>
        </div>
        <div className="dialog-footer"><button className="form-btn" onClick={close}>{busy ? 'Cancel and close' : 'Close'}</button></div>
      </div>
    </div>
  );
}
