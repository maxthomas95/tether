import { useState, useCallback, useEffect, useMemo } from 'react';
import { TerminalPanel } from './components/TerminalPanel';
import { RepoGroup } from './components/sidebar/RepoGroup';
import { NewSessionDialog } from './components/sidebar/NewSessionDialog';
import { NewEnvironmentDialog } from './components/sidebar/NewEnvironmentDialog';
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle';
import { SettingsDialog } from './components/SettingsDialog';
import { useTerminalManager } from './hooks/useTerminalManager';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import type { SessionInfo, SessionState, EnvironmentInfo, EnvironmentType } from '../shared/types';

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const termManager = useTerminalManager();

  // Load environments on mount
  useEffect(() => {
    window.electronAPI.environment.list().then(setEnvironments);
  }, []);

  // Subscribe to PTY data and state changes
  useEffect(() => {
    const removeData = window.electronAPI.session.onData((sid, data) => {
      termManager.writeData(sid, data);
    });
    const removeState = window.electronAPI.session.onStateChange((sid, state: SessionState) => {
      setSessions(prev => prev.map(s => s.id === sid ? { ...s, state } : s));
    });
    const removeExit = window.electronAPI.session.onExited((sid) => {
      const managed = termManager.getOrCreate(sid);
      managed.terminal.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
    });
    return () => { removeData(); removeState(); removeExit(); };
  }, [termManager]);

  // Activate terminal when active session changes
  useEffect(() => {
    if (activeSessionId) {
      termManager.activate(activeSessionId);
    }
  }, [activeSessionId, termManager]);

  const handleCreateSession = useCallback(async (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>) => {
    try {
      const session = await window.electronAPI.session.create({ workingDir, label: label || undefined, environmentId, env });
      termManager.getOrCreate(session.id);
      setSessions(prev => [...prev, session]);
      setActiveSessionId(session.id);
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }, [termManager]);

  const handleCreateEnvironment = useCallback(async (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => {
    try {
      const env = await window.electronAPI.environment.create({ name, type, config, envVars });
      setEnvironments(prev => [...prev, env]);
    } catch (err) {
      console.error('Failed to create environment:', err);
    }
  }, []);

  const handleStop = useCallback(async (id: string) => {
    await window.electronAPI.session.stop(id);
  }, []);

  const handleKill = useCallback(async (id: string) => {
    await window.electronAPI.session.kill(id);
  }, []);

  const handleRename = useCallback(async (id: string, label: string) => {
    await window.electronAPI.session.rename(id, label);
    setSessions(prev => prev.map(s => s.id === id ? { ...s, label } : s));
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    await window.electronAPI.session.remove(id);
    termManager.remove(id);
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== id);
      if (activeSessionId === id) {
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
      return remaining;
    });
  }, [activeSessionId, termManager]);

  const toggleGroup = useCallback((envId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(envId)) next.delete(envId);
      else next.add(envId);
      return next;
    });
  }, []);

  // Keyboard shortcuts
  const shortcutActions = useMemo(() => ({
    onNewSession: () => setSessionDialogOpen(true),
    onToggleSidebar: () => setSidebarVisible(v => !v),
    onStopSession: () => { if (activeSessionId) handleStop(activeSessionId); },
    onSwitchSession: (index: number) => {
      if (index < sessions.length) setActiveSessionId(sessions[index].id);
    },
    onNextSession: () => {
      if (sessions.length === 0) return;
      const idx = sessions.findIndex(s => s.id === activeSessionId);
      setActiveSessionId(sessions[(idx + 1) % sessions.length].id);
    },
    onPrevSession: () => {
      if (sessions.length === 0) return;
      const idx = sessions.findIndex(s => s.id === activeSessionId);
      setActiveSessionId(sessions[(idx - 1 + sessions.length) % sessions.length].id);
    },
  }), [activeSessionId, sessions, handleStop]);

  useKeyboardShortcuts(shortcutActions);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeEnv = activeSession?.environmentId
    ? environments.find(e => e.id === activeSession.environmentId)
    : environments.find(e => e.type === 'local');

  return (
    <div className="app-layout">
      <aside
        className="sidebar"
        style={{
          width: sidebarVisible ? sidebarWidth : 0,
          minWidth: sidebarVisible ? 180 : 0,
          overflow: sidebarVisible ? undefined : 'hidden',
          borderRight: sidebarVisible ? undefined : 'none',
        }}
      >
        <div className="sidebar-header">
          <button className="new-session-btn" onClick={() => setSessionDialogOpen(true)}>
            + New session
          </button>
          <button
            className="new-session-btn"
            onClick={() => setEnvDialogOpen(true)}
            style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}
          >
            + Add environment
          </button>
          <button
            className="new-session-btn"
            onClick={() => setSettingsOpen(true)}
            style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}
          >
            Settings
          </button>
        </div>
        <div className="sidebar-content">
          {environments.map(env => {
            const envSessions = sessions.filter(s => {
              if (env.type === 'local') return !s.environmentId || s.environmentId === env.id;
              return s.environmentId === env.id;
            });
            const isCollapsed = collapsedGroups.has(env.id);
            const runningCount = envSessions.filter(s =>
              s.state === 'running' || s.state === 'waiting',
            ).length;

            return (
              <div key={env.id} className="env-group">
                <div
                  className="env-group-header"
                  onClick={() => toggleGroup(env.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <span>
                    {isCollapsed ? '\u25b6' : '\u25bc'} {env.name}
                    {runningCount > 0 && (
                      <span className="env-group-active"> {runningCount} active</span>
                    )}
                  </span>
                  <span className="env-group-count">({envSessions.length})</span>
                </div>
                {!isCollapsed && envSessions.length > 0 && (
                  (() => {
                    // Group sessions by working directory
                    const byDir = new Map<string, SessionInfo[]>();
                    for (const s of envSessions) {
                      const dir = s.workingDir;
                      if (!byDir.has(dir)) byDir.set(dir, []);
                      byDir.get(dir)!.push(s);
                    }
                    return Array.from(byDir.entries()).map(([dir, dirSessions]) => (
                      <RepoGroup
                        key={dir}
                        repoPath={dir}
                        sessions={dirSessions}
                        activeSessionId={activeSessionId}
                        onSelectSession={setActiveSessionId}
                        onStop={handleStop}
                        onKill={handleKill}
                        onRename={handleRename}
                        onRemove={handleRemove}
                      />
                    ));
                  })()
                )}
                {!isCollapsed && envSessions.length === 0 && (
                  <div className="session-item" style={{ opacity: 0.5 }}>
                    <span className="status-dot status-dot--idle" />
                    <div className="session-info">
                      <span className="session-path">No sessions</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
      {sidebarVisible && <SidebarResizeHandle onResize={setSidebarWidth} />}
      <main className="terminal-panel">
        <div className="terminal-header">
          {activeSession ? (
            <span className="terminal-header-text">
              <span
                className={`status-dot status-dot--${getStatusClass(activeSession.state)}`}
                style={{ display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }}
              />
              {activeSession.label}
              {' \u00b7 '}{abbreviatePath(activeSession.workingDir)}
              {' \u00b7 '}{activeEnv ? `${activeEnv.type}${activeEnv.type === 'ssh' ? ':' + (activeEnv.config?.host || '') : ''}` : 'local'}
            </span>
          ) : (
            <span className="terminal-header-text">Tether</span>
          )}
        </div>
        <TerminalPanel
          sessionId={activeSessionId}
          containerRef={termManager.containerRef}
          onResize={termManager.fitActive}
        />
      </main>

      <NewSessionDialog
        isOpen={sessionDialogOpen}
        environments={environments}
        onClose={() => setSessionDialogOpen(false)}
        onCreate={handleCreateSession}
      />
      <NewEnvironmentDialog
        isOpen={envDialogOpen}
        onClose={() => setEnvDialogOpen(false)}
        onCreate={handleCreateEnvironment}
      />
      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function getStatusClass(state: SessionState): string {
  switch (state) {
    case 'running': case 'starting': return 'running';
    case 'waiting': return 'waiting';
    case 'stopped': case 'dead': return 'dead';
    default: return 'idle';
  }
}

function abbreviatePath(p: string): string {
  const home = window.electronAPI.homeDir;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}
