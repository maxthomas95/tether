import { useState, useCallback, useEffect, useMemo } from 'react';
import { SplitLayout } from './components/SplitLayout';
import { RepoGroup } from './components/sidebar/RepoGroup';
import { NewSessionDialog } from './components/sidebar/NewSessionDialog';
import { NewEnvironmentDialog } from './components/sidebar/NewEnvironmentDialog';
import { ResumeChatDialog } from './components/sidebar/ResumeChatDialog';
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle';
import { SettingsDialog } from './components/SettingsDialog';
import { MenuBar } from './components/MenuBar';
import { KeyboardShortcutsDialog } from './components/KeyboardShortcutsDialog';
import { AboutDialog } from './components/AboutDialog';
import { SetupWizard } from './components/SetupWizard';
import { Notifications, useNotifications } from './components/Notifications';
import { useTerminalManager } from './hooks/useTerminalManager';
import { useLayoutState } from './hooks/useLayoutState';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import { themeList } from './styles/themes';
import { generatePaneId, findLeaf, getLeaves } from './lib/layout-tree';
import type { LayoutNode } from '../shared/layout-types';
import type { SessionInfo, SessionState, EnvironmentInfo, EnvironmentType, LaunchProfileInfo, CreateSessionOptions } from '../shared/types';
import type { MenuDef } from './components/MenuBar';
import logoSrc from './assets/logo.png';

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [profiles, setProfiles] = useState<LaunchProfileInfo[]>([]);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [enablePaneSplitting, setEnablePaneSplitting] = useState(false);
  const [resumePickerFor, setResumePickerFor] = useState<{ sessionId: string; workingDir: string; currentTranscriptId?: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const { themeName, setTheme, xtermTheme } = useTheme();
  const termManager = useTerminalManager(xtermTheme);
  const { layoutState, layoutDispatch } = useLayoutState();
  const { notifications, notify, dismiss } = useNotifications();

  // Derive activeSessionId from focused pane
  const focusedLeaf = layoutState.focusedPaneId && layoutState.root
    ? findLeaf(layoutState.root, layoutState.focusedPaneId)
    : null;
  const activeSessionId = focusedLeaf?.sessionId ?? null;

  // Load profiles on mount
  useEffect(() => {
    window.electronAPI.profile.list().then(setProfiles).catch(() => {});
  }, []);

  // Load resume-related UI settings
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
      window.electronAPI.config.get?.('enablePaneSplitting')?.catch(() => null),
    ]).then(([badge, picker, splitting]) => {
      if (cancelled) return;
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
      setEnablePaneSplitting(splitting === 'true');
    });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Check for first launch
  useEffect(() => {
    window.electronAPI.config.get('setupComplete').then(val => {
      if (val !== 'true') setSetupWizardOpen(true);
    }).catch(() => {});
  }, []);

  // Load environments on mount, then restore workspace
  useEffect(() => {
    let mounted = true;
    window.electronAPI.environment.list().then(async (envs) => {
      if (!mounted) return;
      setEnvironments(envs);

      const restoreSetting = await window.electronAPI.config.get?.('restoreOnLaunch');
      if (restoreSetting === 'false') return;

      const resumeSetting = await window.electronAPI.config.get?.('resumePreviousChats');
      const resumeChats = resumeSetting !== 'false';

      const workspace = await window.electronAPI.workspace?.load?.();
      if (!workspace || !workspace.sessions.length) return;

      // Build layout tree from restored sessions
      let root: LayoutNode | null = null;
      let focusPaneId: string | null = null;

      for (let i = 0; i < workspace.sessions.length; i++) {
        const saved = workspace.sessions[i];
        try {
          const session = await window.electronAPI.session.create({
            workingDir: saved.workingDir,
            label: saved.label || undefined,
            environmentId: saved.environmentId,
            cliTool: saved.cliTool as CreateSessionOptions['cliTool'],
            customCliBinary: saved.customCliBinary,
            resumeClaudeSessionId: resumeChats ? saved.claudeSessionId : undefined,
          });
          if (!mounted) return;
          termManager.getOrCreate(session.id);
          setSessions(prev => [...prev, session]);

          const paneId = generatePaneId();
          if (!root) {
            root = { type: 'leaf', id: paneId, sessionId: session.id };
            focusPaneId = paneId;
          } else {
            // Stack subsequent sessions to the right of the first leaf
            const leaves = getLeaves(root);
            if (leaves.length > 0) {
              const { addPane } = await import('./lib/layout-tree');
              root = addPane(root, leaves[leaves.length - 1].id, session.id, 'right');
            }
          }

          if (i === workspace.activeIndex) {
            const leaves = getLeaves(root!);
            const leaf = leaves.find(l => l.sessionId === session.id);
            if (leaf) focusPaneId = leaf.id;
          }
        } catch {
          // Skip sessions that fail to restore
        }
      }

      if (root) {
        layoutDispatch({ type: 'SET_ROOT', root });
        if (focusPaneId) layoutDispatch({ type: 'SET_FOCUS', paneId: focusPaneId });
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
            cliTool: s.cliTool,
            customCliBinary: s.customCliBinary,
            claudeSessionId: s.claudeSessionId,
          })),
          Math.max(0, activeIndex),
        );
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessions, activeSessionId]);

  // Enforce single-leaf layout invariant when pane splitting is disabled.
  // Runs after toggling the setting off, and after workspace restore on an app
  // launch where the setting is already off.
  useEffect(() => {
    if (enablePaneSplitting) return;
    if (!layoutState.root || layoutState.root.type !== 'split') return;
    const leaves = getLeaves(layoutState.root);
    if (leaves.length === 0) return;
    const focused = layoutState.focusedPaneId
      ? leaves.find(l => l.id === layoutState.focusedPaneId)
      : null;
    const keep = focused ?? leaves[0];
    const newPaneId = generatePaneId();
    const root: LayoutNode = { type: 'leaf', id: newPaneId, sessionId: keep.sessionId };
    layoutDispatch({ type: 'SET_ROOT', root });
    layoutDispatch({ type: 'SET_FOCUS', paneId: newPaneId });
  }, [enablePaneSplitting, layoutState.root, layoutState.focusedPaneId, layoutDispatch]);

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
    const removeLabelChange = window.electronAPI.session.onLabelChanged((sid, label) => {
      setSessions(prev => prev.map(s => s.id === sid ? { ...s, label } : s));
    });
    return () => { removeData(); removeState(); removeExit(); removeLabelChange(); };
  }, [termManager]);

  const handleCreateSession = useCallback(async (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>, cliArgs?: string[], resumeClaudeSessionId?: string, profileId?: string, cloneUrl?: string, cliTool?: CreateSessionOptions['cliTool'], customCliBinary?: string) => {
    try {
      const session = await window.electronAPI.session.create({ workingDir, label: label || undefined, environmentId, cliTool, customCliBinary, env, cliArgs, resumeClaudeSessionId, profileId, cloneUrl });
      termManager.getOrCreate(session.id);
      setSessions(prev => [...prev, session]);

      const paneId = generatePaneId();
      if (!layoutState.root) {
        const root: LayoutNode = { type: 'leaf', id: paneId, sessionId: session.id };
        layoutDispatch({ type: 'SET_ROOT', root });
        layoutDispatch({ type: 'SET_FOCUS', paneId });
      } else if (!enablePaneSplitting) {
        // Single-pane mode: replace the focused pane's session instead of splitting.
        const targetPaneId = layoutState.focusedPaneId ?? getLeaves(layoutState.root)[0]?.id;
        if (targetPaneId) {
          layoutDispatch({ type: 'REPLACE_SESSION', paneId: targetPaneId, sessionId: session.id });
          layoutDispatch({ type: 'SET_FOCUS', paneId: targetPaneId });
        }
      } else if (layoutState.focusedPaneId) {
        layoutDispatch({ type: 'ADD_PANE', targetPaneId: layoutState.focusedPaneId, sessionId: session.id, zone: 'right' });
      } else {
        const leaves = getLeaves(layoutState.root);
        if (leaves.length > 0) {
          layoutDispatch({ type: 'ADD_PANE', targetPaneId: leaves[0].id, sessionId: session.id, zone: 'right' });
        }
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      notify({
        type: 'error',
        title: 'Failed to create session',
        message: extractErrorMessage(err),
      });
    }
  }, [termManager, layoutState.root, layoutState.focusedPaneId, layoutDispatch, notify, enablePaneSplitting]);

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
  }, []);

  const handleRename = useCallback(async (id: string, label: string) => {
    await window.electronAPI.session.rename(id, label);
    setSessions(prev => prev.map(s => s.id === id ? { ...s, label } : s));
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    await window.electronAPI.session.remove(id);
    termManager.remove(id);
    layoutDispatch({ type: 'REMOVE_SESSION', sessionId: id });
    setSessions(prev => prev.filter(s => s.id !== id));
  }, [termManager, layoutDispatch]);

  const handleDuplicate = useCallback(async (id: string) => {
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    handleCreateSession(source.workingDir, '', source.environmentId || undefined, undefined, undefined, undefined, undefined, undefined, source.cliTool, source.customCliBinary);
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

  // Sidebar session click: focus existing pane or replace focused pane
  const handleSelectSession = useCallback((sessionId: string) => {
    if (layoutState.root) {
      const leaves = getLeaves(layoutState.root);
      const existingLeaf = leaves.find(l => l.sessionId === sessionId);
      if (existingLeaf) {
        layoutDispatch({ type: 'SET_FOCUS', paneId: existingLeaf.id });
        termManager.focusPane(existingLeaf.id);
        return;
      }
    }
    if (layoutState.focusedPaneId) {
      layoutDispatch({ type: 'REPLACE_SESSION', paneId: layoutState.focusedPaneId, sessionId });
    } else if (!layoutState.root) {
      const paneId = generatePaneId();
      const root: LayoutNode = { type: 'leaf', id: paneId, sessionId };
      layoutDispatch({ type: 'SET_ROOT', root });
      layoutDispatch({ type: 'SET_FOCUS', paneId });
    }
  }, [layoutState.root, layoutState.focusedPaneId, layoutDispatch, termManager]);

  const toggleGroup = useCallback((envId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(envId)) next.delete(envId);
      else next.add(envId);
      return next;
    });
  }, []);

  // Drag handlers for sidebar → terminal area
  const handleDragStart = useCallback(() => {
    setIsDragging(true);
    setDraggingPaneId(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    setDraggingPaneId(null);
  }, []);

  // Drag handler for pane header drags
  const handlePaneDragStateChange = useCallback((dragging: boolean, sourcePaneId?: string) => {
    setIsDragging(dragging);
    setDraggingPaneId(dragging ? (sourcePaneId ?? null) : null);
  }, []);

  // Drop handler for empty main area
  const handleMainDragOver = useCallback((e: React.DragEvent) => {
    if (!layoutState.root) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [layoutState.root]);

  const handleMainDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sessionId = e.dataTransfer.getData('application/tether-session');
    if (!sessionId) return;

    if (!layoutState.root) {
      const paneId = generatePaneId();
      const root: LayoutNode = { type: 'leaf', id: paneId, sessionId };
      layoutDispatch({ type: 'SET_ROOT', root });
      layoutDispatch({ type: 'SET_FOCUS', paneId });
    }
    setIsDragging(false);
  }, [layoutState.root, layoutDispatch]);

  const handleSetupWizardClose = useCallback(() => {
    setSetupWizardOpen(false);
    window.electronAPI.config.set('setupComplete', 'true');
  }, []);

  // Keyboard shortcuts
  const shortcutActions = useMemo(() => ({
    onNewSession: () => setSessionDialogOpen(true),
    onToggleSidebar: () => setSidebarVisible(v => !v),
    onStopSession: () => { if (activeSessionId) handleStop(activeSessionId); },
    onOpenSettings: () => setSettingsOpen(true),
    onSwitchSession: (index: number) => {
      if (!layoutState.root) return;
      const leaves = getLeaves(layoutState.root);
      if (index < leaves.length) {
        layoutDispatch({ type: 'SET_FOCUS', paneId: leaves[index].id });
        termManager.focusPane(leaves[index].id);
      }
    },
    onNextSession: () => {
      if (!layoutState.root) return;
      const leaves = getLeaves(layoutState.root);
      if (leaves.length === 0) return;
      const idx = leaves.findIndex(l => l.id === layoutState.focusedPaneId);
      const next = leaves[(idx + 1) % leaves.length];
      layoutDispatch({ type: 'SET_FOCUS', paneId: next.id });
      termManager.focusPane(next.id);
    },
    onPrevSession: () => {
      if (!layoutState.root) return;
      const leaves = getLeaves(layoutState.root);
      if (leaves.length === 0) return;
      const idx = leaves.findIndex(l => l.id === layoutState.focusedPaneId);
      const prev = leaves[(idx - 1 + leaves.length) % leaves.length];
      layoutDispatch({ type: 'SET_FOCUS', paneId: prev.id });
      termManager.focusPane(prev.id);
    },
  }), [activeSessionId, layoutState.root, layoutState.focusedPaneId, layoutDispatch, termManager, handleStop]);

  useKeyboardShortcuts(shortcutActions);

  const activeSession = sessions.find(s => s.id === activeSessionId);

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
        { label: 'Next Pane', shortcut: 'Ctrl+\u2193', onClick: shortcutActions.onNextSession, disabled: !layoutState.root || getLeaves(layoutState.root).length < 2 },
        { label: 'Previous Pane', shortcut: 'Ctrl+\u2191', onClick: shortcutActions.onPrevSession, disabled: !layoutState.root || getLeaves(layoutState.root).length < 2 },
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
        { label: 'Documentation', onClick: () => window.electronAPI.docs.open() },
        { separator: true },
        { label: 'Setup Wizard...', onClick: () => setSetupWizardOpen(true) },
        { separator: true },
        { label: 'About Tether', onClick: () => setAboutOpen(true) },
      ],
    },
  ], [activeSessionId, activeSession, isAlive, layoutState.root, themeName, setTheme, handleStop, handleKill, handleRemove, handleDuplicate, shortcutActions]);

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
                        onSelectSession={handleSelectSession}
                        onStop={handleStop}
                        onKill={handleKill}
                        onRename={handleRename}
                        onRemove={handleRemove}
                        onDuplicate={handleDuplicate}
                        onResumePrevious={enableResumePicker ? handleOpenResumePicker : undefined}
                        showResumeBadge={showResumeBadge}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
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
      <main
        className={`terminal-panel ${isDragging && !layoutState.root ? 'terminal-panel--drop-active' : ''}`}
        onDragOver={handleMainDragOver}
        onDrop={handleMainDrop}
      >
        {layoutState.root ? (
          <SplitLayout
            node={layoutState.maximizedPaneId
              ? findLeaf(layoutState.root, layoutState.maximizedPaneId) || layoutState.root
              : layoutState.root}
            layoutDispatch={layoutDispatch}
            termManager={termManager}
            sessions={sessions}
            isDragging={isDragging}
            draggingPaneId={draggingPaneId}
            onDragStateChange={handlePaneDragStateChange}
            focusedPaneId={layoutState.focusedPaneId}
            maximizedPaneId={layoutState.maximizedPaneId}
            enablePaneSplitting={enablePaneSplitting}
          />
        ) : (
          <div className="terminal-container">
            <div className="terminal-placeholder">
              <img src={logoSrc} alt="Tether" className="welcome-logo" />
              <p>Welcome to Tether</p>
              <p className="terminal-placeholder-sub">Create a new session or drag one here to start</p>
            </div>
          </div>
        )}
      </main>
      </div>

      <NewSessionDialog
        isOpen={sessionDialogOpen}
        environments={environments}
        profiles={profiles}
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
        onClose={() => {
          setSettingsOpen(false);
          window.electronAPI.profile.list().then(setProfiles).catch(() => {});
        }}
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
      <SetupWizard isOpen={setupWizardOpen} onClose={handleSetupWizardClose} />
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

function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s);
  return match ? match[1].trim() : raw;
}
