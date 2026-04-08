import { useState, useCallback, useEffect, useMemo } from 'react';
import { TerminalPanel } from './components/TerminalPanel';
import { RepoGroup } from './components/sidebar/RepoGroup';
import { NewSessionDialog } from './components/sidebar/NewSessionDialog';
import { NewEnvironmentDialog } from './components/sidebar/NewEnvironmentDialog';
import { ResumeChatDialog } from './components/sidebar/ResumeChatDialog';
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle';
import { SettingsDialog } from './components/SettingsDialog';
import { MenuBar } from './components/MenuBar';
import { KeyboardShortcutsDialog } from './components/KeyboardShortcutsDialog';
import { AboutDialog } from './components/AboutDialog';
import { Notifications, useNotifications } from './components/Notifications';
import { useTerminalManager } from './hooks/useTerminalManager';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import { themeList } from './styles/themes';
import type { SessionInfo, SessionState, EnvironmentInfo, EnvironmentType } from '../shared/types';
import type { MenuDef } from './components/MenuBar';

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [resumePickerFor, setResumePickerFor] = useState<{ sessionId: string; workingDir: string; currentTranscriptId?: string } | null>(null);
  const { themeName, setTheme, xtermTheme } = useTheme();
  const termManager = useTerminalManager(xtermTheme);
  const { notifications, notify, dismiss } = useNotifications();

  // Load resume-related UI settings; re-read whenever the Settings dialog closes
  // so toggles take effect without a relaunch.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
    ]).then(([badge, picker]) => {
      if (cancelled) return;
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
    });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Load resume-related UI settings; re-read whenever the Settings dialog closes
  // so toggles take effect without a relaunch.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
    ]).then(([badge, picker]) => {
      if (cancelled) return;
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
    });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Load environments on mount, then restore workspace
  useEffect(() => {
    let mounted = true;
    window.electronAPI.environment.list().then(async (envs) => {
      if (!mounted) return;
      setEnvironments(envs);

      // Check if restore is enabled (default: true)
      const restoreSetting = await window.electronAPI.config.get?.('restoreOnLaunch');
      if (restoreSetting === 'false') return;

      // Resume previous chats by default; opt out via setting.
      const resumeSetting = await window.electronAPI.config.get?.('resumePreviousChats');
      const resumeChats = resumeSetting !== 'false';

      // Load saved workspace
      const workspace = await window.electronAPI.workspace?.load?.();
      if (!workspace || !workspace.sessions.length) return;

      // Restore sessions
      for (let i = 0; i < workspace.sessions.length; i++) {
        const saved = workspace.sessions[i];
        try {
          const session = await window.electronAPI.session.create({
            workingDir: saved.workingDir,
            label: saved.label || undefined,
            environmentId: saved.environmentId,
            resumeClaudeSessionId: resumeChats ? saved.claudeSessionId : undefined,
          });
          if (!mounted) return;
          termManager.getOrCreate(session.id);
          setSessions(prev => [...prev, session]);
          if (i === workspace.activeIndex) {
            setActiveSessionId(session.id);
          }
        } catch {
          // Skip sessions that fail to restore (e.g. dir no longer exists)
        }
      }
    });
    return () => { mounted = false; };
  }, []);

  // Save workspace on close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessions.length > 0) {
        const activeIndex = sessions.findIndex(s => s.id === activeSessionId);
        window.electronAPI.workspace?.save?.(
          sessions.map(s => ({
            workingDir: s.workingDir,
            label: s.label,
            environmentId: s.environmentId || undefined,
            claudeSessionId: s.claudeSessionId,
          })),
          Math.max(0, activeIndex),
        );
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessions, activeSessionId]);

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

  const handleCreateSession = useCallback(async (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>, cliArgs?: string[], resumeClaudeSessionId?: string) => {
    try {
      const session = await window.electronAPI.session.create({ workingDir, label: label || undefined, environmentId, env, cliArgs, resumeClaudeSessionId });
      termManager.getOrCreate(session.id);
      setSessions(prev => [...prev, session]);
      setActiveSessionId(session.id);
    } catch (err) {
      console.error('Failed to create session:', err);
      notify({
        type: 'error',
        title: 'Failed to create session',
        message: extractErrorMessage(err),
      });
    }
  }, [termManager, notify]);

  const handleCreateEnvironment = useCallback(async (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => {
    try {
      const env = await window.electronAPI.environment.create({ name, type, config, envVars });
      setEnvironments(prev => [...prev, env]);
    } catch (err) {
      console.error('Failed to create environment:', err);
      notify({
        type: 'error',
        title: 'Failed to create environment',
        message: extractErrorMessage(err),
      });
    }
  }, [notify]);

  const handleStop = useCallback(async (id: string) => {
    await window.electronAPI.session.stop(id);
  }, []);

  const handleKill = useCallback(async (id: string) => {
    await window.electronAPI.session.kill(id);
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

  const handleDuplicate = useCallback(async (id: string) => {
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    handleCreateSession(source.workingDir, '', source.environmentId || undefined);
  }, [sessions, handleCreateSession]);

  const handleOpenResumePicker = useCallback((id: string) => {
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    setResumePickerFor({
      sessionId: id,
      workingDir: source.workingDir,
      currentTranscriptId: source.claudeSessionId,
    });
  }, [sessions]);

  const handlePickResume = useCallback((transcriptId: string) => {
    if (!resumePickerFor) return;
    const source = sessions.find(s => s.id === resumePickerFor.sessionId);
    if (!source) return;
    handleCreateSession(
      source.workingDir,
      '',
      source.environmentId || undefined,
      undefined,
      undefined,
      transcriptId,
    );
  }, [resumePickerFor, sessions, handleCreateSession]);

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
    onOpenSettings: () => setSettingsOpen(true),
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

  const isAlive = activeSession
    ? activeSession.state !== 'stopped' && activeSession.state !== 'dead'
    : false;

  const menus: MenuDef[] = useMemo(() => [
    {
      label: 'File',
      items: [
        { label: 'New Session...', shortcut: 'Ctrl+N', onClick: () => setSessionDialogOpen(true) },
        { label: 'New Environment...', onClick: () => setEnvDialogOpen(true) },
        { separator: true },
        { label: 'Settings...', shortcut: 'Ctrl+,', onClick: () => setSettingsOpen(true) },
        { separator: true },
        { label: 'Exit', shortcut: 'Alt+F4', onClick: () => window.close() },
      ],
    },
    {
      label: 'Session',
      items: [
        { label: 'Stop Session', shortcut: 'Ctrl+W', onClick: () => { if (activeSessionId) handleStop(activeSessionId); }, disabled: !isAlive },
        { label: 'Duplicate Session', onClick: () => { if (activeSessionId) handleDuplicate(activeSessionId); }, disabled: !activeSession },
        { separator: true },
        { label: 'Next Session', shortcut: 'Ctrl+\u2193', onClick: shortcutActions.onNextSession, disabled: sessions.length < 2 },
        { label: 'Previous Session', shortcut: 'Ctrl+\u2191', onClick: shortcutActions.onPrevSession, disabled: sessions.length < 2 },
        { separator: true },
        { label: 'Kill Session', onClick: () => { if (activeSessionId) handleKill(activeSessionId); }, disabled: !isAlive, danger: true },
        { label: 'Remove Session', onClick: () => { if (activeSessionId) handleRemove(activeSessionId); }, disabled: !activeSession, danger: true },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Toggle Sidebar', shortcut: 'Ctrl+B', onClick: () => setSidebarVisible(v => !v) },
        { separator: true },
        ...themeList.map(t => ({
          label: t.label,
          checked: themeName === t.name,
          onClick: () => setTheme(t.name),
        })),
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+/', onClick: () => setShortcutsOpen(true) },
        { separator: true },
        { label: 'Documentation', disabled: true },
        { separator: true },
        { label: 'About Tether', onClick: () => setAboutOpen(true) },
      ],
    },
  ], [activeSessionId, activeSession, isAlive, sessions.length, themeName, setTheme, handleStop, handleKill, handleRemove, handleDuplicate, shortcutActions]);

  return (
    <div className="app-layout">
      <MenuBar menus={menus} />
      <div className="app-body">
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
                        onDuplicate={handleDuplicate}
                        onResumePrevious={enableResumePicker ? handleOpenResumePicker : undefined}
                        showResumeBadge={showResumeBadge}
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
            <span className="terminal-header-text">No active session</span>
          )}
        </div>
        <TerminalPanel
          sessionId={activeSessionId}
          containerRef={termManager.containerRef}
          onResize={termManager.fitActive}
        />
      </main>
      </div>

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
        currentTheme={themeName}
        onThemeChange={setTheme}
      />
      <KeyboardShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <AboutDialog
        isOpen={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />
      {resumePickerFor && (
        <ResumeChatDialog
          isOpen={true}
          workingDir={resumePickerFor.workingDir}
          currentTranscriptId={resumePickerFor.currentTranscriptId}
          onClose={() => setResumePickerFor(null)}
          onPick={handlePickResume}
        />
      )}
      <Notifications notifications={notifications} onDismiss={dismiss} />
    </div>
  );
}

/**
 * Pull a readable error message out of whatever the IPC layer threw.
 * Electron wraps remote errors as "Error invoking remote method 'X': Error: <real>"
 * — strip the wrapper so the toast shows the actual cause.
 */
function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s);
  return match ? match[1].trim() : raw;
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
