import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ITheme } from '@xterm/xterm';
import { SplitLayout } from './components/SplitLayout';
import { RepoGroup } from './components/sidebar/RepoGroup';
import { NewSessionDialog } from './components/sidebar/NewSessionDialog';
import { NewEnvironmentDialog } from './components/sidebar/NewEnvironmentDialog';
import { ResumeChatDialog } from './components/sidebar/ResumeChatDialog';
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle';
import { QuotaFooter } from './components/sidebar/QuotaFooter';
import { GlobalUsageFooter } from './components/sidebar/GlobalUsageFooter';
import { VaultStatusPill } from './components/sidebar/VaultStatusPill';
import { VaultLoginPromptDialog } from './components/VaultLoginPromptDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { MenuBar } from './components/MenuBar';
import { KeyboardShortcutsDialog } from './components/KeyboardShortcutsDialog';
import { UsageHistoryDialog } from './components/UsageHistoryDialog';
import { AboutDialog } from './components/AboutDialog';
import { HostKeyVerifyDialog } from './components/HostKeyVerifyDialog';
import { SetupWizard } from './components/SetupWizard';
import { Notifications, useNotifications } from './components/Notifications';
import { ConfirmDialog, useConfirmDialog } from './components/ConfirmDialog';
import { useTerminalManager } from './hooks/useTerminalManager';
import { useLayoutState } from './hooks/useLayoutState';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import { themeList } from './styles/themes';
import {
  addPane,
  clampMaxPanes,
  generatePaneId,
  findLeaf,
  getLeaves,
  getLeafCount,
  isConstrainedLayout,
  normalizeToConstrained,
} from './lib/layout-tree';
import { toolSupportsHistory } from '../shared/cli-tools';
import { onKeyActivate, stopPropagationOnKey } from './utils/a11y';
import { extractErrorMessage, formatSessionExitMessage } from './utils/errors';
import { nextDuplicateLabel } from './utils/duplicate-label';
import type { LayoutNode } from '../shared/layout-types';
import type { SessionInfo, SessionState, EnvironmentInfo, EnvironmentType, LaunchProfileInfo, CreateSessionOptions, UpdateCheckResult, RepoGroupPref, SessionOrderPref, HostVerifyRequest } from '../shared/types';
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
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [hostVerifyRequest, setHostVerifyRequest] = useState<HostVerifyRequest | null>(null);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [allowHelm, setAllowHelm] = useState(false);
  const [enablePaneSplitting, setEnablePaneSplitting] = useState(false);
  const [maxPanes, setMaxPanes] = useState(4);
  const [resumePickerFor, setResumePickerFor] = useState<{ sessionId: string; workingDir: string; cliTool: CreateSessionOptions['cliTool']; currentTranscriptId?: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [repoGroupPrefs, setRepoGroupPrefs] = useState<RepoGroupPref[]>([]);
  const [sessionOrderPrefs, setSessionOrderPrefs] = useState<SessionOrderPref[]>([]);
  const [hideTerminalCursor, setHideTerminalCursor] = useState(true);
  const [defaultTerminalFontSize, setDefaultTerminalFontSize] = useState(14);
  // Empty string = use the CSS var default from tokens.css (Cascadia Code).
  // Non-empty = user-selected font stack, applied to `--font-mono-terminal` on
  // <html>, which xterm re-reads on the next theme/font effect tick.
  const [defaultTerminalFontFamily, setDefaultTerminalFontFamily] = useState<string>('');
  // Empty string = use the tokens.css default (IBM Plex Sans). Non-empty
  // overrides `--font-sans` on <html> so the whole UI re-renders in the
  // chosen face. Spacing tokens were tuned for Plex Sans; very different
  // faces may pack slightly tight or loose.
  const [uiFontFamily, setUiFontFamily] = useState<string>('');
  const [editingEnv, setEditingEnv] = useState<EnvironmentInfo | null>(null);
  const [envMenuOpenId, setEnvMenuOpenId] = useState<string | null>(null);
  const envMenuRef = useRef<HTMLDivElement>(null);
  const { themeName, setTheme, xtermTheme } = useTheme();
  const effectiveXtermTheme = useMemo(
    () => hideTerminalCursor ? withHiddenXtermCursor(xtermTheme) : xtermTheme,
    [hideTerminalCursor, xtermTheme],
  );
  const termManager = useTerminalManager(effectiveXtermTheme, defaultTerminalFontFamily);
  const { layoutState, layoutDispatch } = useLayoutState();
  const { notifications, notify, dismiss } = useNotifications();
  const notifyError = useCallback((title: string, err: unknown) => {
    notify({ type: 'error', title, message: extractErrorMessage(err) });
  }, [notify]);
  const notifyVaultAuthError = useCallback((err: unknown) => {
    const message = extractErrorMessage(err);
    if (/cancel/i.test(message)) return;
    notify({ type: 'error', title: 'Vault login failed', message });
  }, [notify]);
  const { confirm: confirmDialog, dialogProps: confirmDialogProps } = useConfirmDialog();
  const [vaultPrompt, setVaultPrompt] = useState<{ reason?: string; onDone: (loggedIn: boolean) => void } | null>(null);
  const expectedSessionExitIds = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<SessionInfo[]>([]);
  // Gate the persist effect until the restore effect has finished reading the
  // saved workspace. Otherwise the initial-mount persist (with sessions=[])
  // races ahead of the multi-IPC restore chain and clobbers the saved
  // workspace before workspace.load() can read it. Ref (not state) so the
  // flag flip doesn't itself trigger a persist with empty sessions.
  const restorationCompleteRef = useRef(false);
  const effectiveMaxPanes = enablePaneSplitting ? maxPanes : 1;

  const markExpectedSessionExit = useCallback((sessionId: string) => {
    expectedSessionExitIds.current.add(sessionId);
    globalThis.setTimeout(() => {
      expectedSessionExitIds.current.delete(sessionId);
    }, 30_000);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('tether-hide-cursor', hideTerminalCursor);
    return () => document.body.classList.remove('tether-hide-cursor');
  }, [hideTerminalCursor]);

  // Push the user's terminal font choice into the `--font-mono-terminal` CSS
  // var so xterm picks it up. Empty value means "use the tokens.css default."
  useEffect(() => {
    const trimmed = defaultTerminalFontFamily.trim();
    if (trimmed) {
      document.documentElement.style.setProperty('--font-mono-terminal', trimmed);
    } else {
      document.documentElement.style.removeProperty('--font-mono-terminal');
    }
  }, [defaultTerminalFontFamily]);

  // Same pattern for the UI font (`--font-sans`).
  useEffect(() => {
    const trimmed = uiFontFamily.trim();
    if (trimmed) {
      document.documentElement.style.setProperty('--font-sans', trimmed);
    } else {
      document.documentElement.style.removeProperty('--font-sans');
    }
  }, [uiFontFamily]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Derive activeSessionId from focused pane
  const focusedLeaf = layoutState.focusedPaneId && layoutState.root
    ? findLeaf(layoutState.root, layoutState.focusedPaneId)
    : null;
  const activeSessionId = focusedLeaf?.sessionId ?? null;
  const environmentById = useMemo(() => new Map(environments.map(env => [env.id, env])), [environments]);

  // Load profiles on mount
  useEffect(() => {
    window.electronAPI.profile.list().then(setProfiles).catch(() => {});
  }, []);

  // Load repo group preferences on mount
  useEffect(() => {
    window.electronAPI.repoGroup.getPrefs().then(setRepoGroupPrefs).catch(() => {});
  }, []);

  // Load session-within-group order preferences on mount
  useEffect(() => {
    window.electronAPI.sessionOrder.getPrefs().then(setSessionOrderPrefs).catch(() => {});
  }, []);

  // Load resume-related UI settings
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
      window.electronAPI.config.get?.('enablePaneSplitting')?.catch(() => null),
      window.electronAPI.config.get?.('maxPanes')?.catch(() => null),
      window.electronAPI.config.get?.('hideTerminalCursor')?.catch(() => null),
      window.electronAPI.config.get?.('allowHelm')?.catch(() => null),
      window.electronAPI.config.get?.('terminalFontSize')?.catch(() => null),
      window.electronAPI.config.get?.('terminalFontFamily')?.catch(() => null),
      window.electronAPI.config.get?.('uiFontFamily')?.catch(() => null),
    ]).then(([badge, picker, splitting, maxPaneValue, hideCursor, helm, fontSize, fontFamily, uiFont]) => {
      if (cancelled) return;
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
      setEnablePaneSplitting(splitting === 'true');
      setMaxPanes(parseMaxPanes(maxPaneValue));
      const shouldHideCursor = hideCursor !== 'false';
      setHideTerminalCursor(shouldHideCursor);
      setAllowHelm(helm === 'true');
      const parsedFontSize = fontSize ? parseInt(fontSize, 10) : NaN;
      if (Number.isFinite(parsedFontSize) && parsedFontSize >= 8 && parsedFontSize <= 32) {
        setDefaultTerminalFontSize(parsedFontSize);
      }
      setDefaultTerminalFontFamily(typeof fontFamily === 'string' ? fontFamily.trim() : '');
      setUiFontFamily(typeof uiFont === 'string' ? uiFont.trim() : '');
    });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Check for first launch
  useEffect(() => {
    window.electronAPI.config.get('setupComplete').then(val => {
      if (val !== 'true') setSetupWizardOpen(true);
    }).catch(() => {});
  }, []);

  // Restore persisted window zoom level on mount
  useEffect(() => {
    window.electronAPI.config.get?.('windowZoomLevel').then(val => {
      const level = val !== null && val !== undefined ? parseFloat(val) : NaN;
      if (Number.isFinite(level)) window.electronAPI.webFrame.setZoomLevel(level);
    }).catch(() => {});
  }, []);

  // Load environments on mount, then restore workspace
  useEffect(() => {
    let mounted = true;
    window.electronAPI.environment.list().then(async (envs) => {
      try {
        if (!mounted) return;
        setEnvironments(envs);

        const restoreSetting = await window.electronAPI.config.get?.('restoreOnLaunch');
        if (restoreSetting === 'false') return;

        const resumeSetting = await window.electronAPI.config.get?.('resumePreviousChats');
        const resumeChats = resumeSetting !== 'false';
        const splittingSetting = await window.electronAPI.config.get?.('enablePaneSplitting');
        const maxPaneSetting = await window.electronAPI.config.get?.('maxPanes');
        const restoreMaxPanes = splittingSetting === 'true' ? parseMaxPanes(maxPaneSetting) : 1;

        const workspace = await window.electronAPI.workspace?.load?.();
        if (!workspace || !workspace.sessions.length) return;

        // Build layout tree from restored sessions
        let root: LayoutNode | null = null;
        let focusPaneId: string | null = null;
        const restoreFailures: Array<{ label: string; error: string }> = [];

        for (let i = 0; i < workspace.sessions.length; i++) {
          const saved = workspace.sessions[i];
          try {
            const session = await window.electronAPI.session.create({
              workingDir: saved.workingDir,
              label: saved.label || undefined,
              environmentId: saved.environmentId,
              cliTool: saved.cliTool as CreateSessionOptions['cliTool'],
              customCliBinary: saved.customCliBinary,
              resumeToolSessionId: resumeChats ? saved.toolSessionId || saved.claudeSessionId : undefined,
              resumeClaudeSessionId: resumeChats && (!saved.cliTool || saved.cliTool === 'claude')
                ? saved.claudeSessionId || saved.toolSessionId
                : undefined,
              worktreeOf: saved.worktreeOf,
              helmEnabled: saved.helmEnabled,
              parentSessionId: saved.parentSessionId,
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
                root = addPane(root, leaves[leaves.length - 1].id, session.id, 'right');
              }
            }

            if (i === workspace.activeIndex) {
              const leaves = getLeaves(root!);
              const leaf = leaves.find(l => l.sessionId === session.id);
              if (leaf) focusPaneId = leaf.id;
            }
          } catch (err) {
            // Skip sessions that fail to restore
            restoreFailures.push({
              label: saved.label || saved.workingDir,
              error: extractErrorMessage(err),
            });
          }
        }

        if (mounted && restoreFailures.length > 0) {
          const first = restoreFailures[0];
          notify({
            type: 'error',
            title: restoreFailures.length === 1
              ? `Failed to restore ${first.label}`
              : `Failed to restore ${restoreFailures.length} sessions`,
            message: first.error,
          });
        }

        if (root) {
          const normalizedRoot = normalizeToConstrained(root, restoreMaxPanes, focusPaneId);
          const focusedSessionId = focusPaneId ? findLeaf(root, focusPaneId)?.sessionId : null;
          const normalizedFocusPaneId = normalizedRoot
            ? getLeaves(normalizedRoot).find(l => l.sessionId === focusedSessionId)?.id
              ?? getLeaves(normalizedRoot).find(l => l.sessionId !== null)?.id
              ?? getLeaves(normalizedRoot)[0]?.id
            : null;
          layoutDispatch({ type: 'SET_ROOT', root: normalizedRoot });
          if (normalizedFocusPaneId) layoutDispatch({ type: 'SET_FOCUS', paneId: normalizedFocusPaneId });
        }
      } finally {
        // Open the persist gate. Done in finally so every exit path (early
        // return for `restoreOnLaunch=false`, empty workspace, partial loop
        // failure, or full restore) flips the flag — otherwise persist would
        // be permanently silent and subsequent user actions wouldn't save.
        if (mounted) restorationCompleteRef.current = true;
      }
    });
    return () => { mounted = false; };
  }, []);

  // Persist workspace on every change. Sync (no debounce) so a close/remove
  // is on disk before the user can quit — `beforeunload` IPC races renderer
  // teardown and can't be relied on as a backup.
  //
  // Gated on restorationCompleteRef so the initial-mount fire (sessions=[])
  // doesn't clobber the saved workspace before the restore effect's chain of
  // IPCs (env.list → 4× config.get → workspace.load) has a chance to read it.
  useEffect(() => {
    if (!restorationCompleteRef.current) return;
    const activeIndex = sessions.findIndex(s => s.id === activeSessionId);
    window.electronAPI.workspace?.save?.(
      sessions.map(s => ({
        workingDir: s.workingDir,
        label: s.label,
        environmentId: s.environmentId || undefined,
        cliTool: s.cliTool,
        customCliBinary: s.customCliBinary,
        toolSessionId: s.toolSessionId || s.claudeSessionId,
        claudeSessionId: s.claudeSessionId,
        worktreeOf: s.worktreeOf,
        helmEnabled: s.helmEnabled,
        parentSessionId: s.parentSessionId,
      })),
      Math.max(0, activeIndex),
    );
  }, [sessions, activeSessionId]);

  // Enforce the constrained 1/2/4 layout invariant after setting changes,
  // workspace restore, or legacy arbitrary split trees.
  useEffect(() => {
    if (
      layoutState.maxPanes === effectiveMaxPanes
      && isConstrainedLayout(layoutState.root, effectiveMaxPanes)
    ) {
      return;
    }
    layoutDispatch({ type: 'SET_MAX_PANES', maxPanes: effectiveMaxPanes });
  }, [
    effectiveMaxPanes,
    layoutState.root,
    layoutState.focusedPaneId,
    layoutState.maxPanes,
    layoutDispatch,
  ]);

  // Subscribe to PTY data and state changes
  useEffect(() => {
    const removeData = window.electronAPI.session.onData((sid, data) => {
      termManager.writeData(sid, data);
    });
    const removeState = window.electronAPI.session.onStateChange((sid, state: SessionState) => {
      setSessions(prev => prev.map(s => s.id === sid ? { ...s, state } : s));
    });
    const removeExit = globalThis.electronAPI.session.onExited((sid, exitInfo) => {
      const managed = termManager.getOrCreate(sid);
      managed.terminal.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
      const wasExpected = expectedSessionExitIds.current.delete(sid);
      if (!wasExpected && exitInfo.exitCode !== 0) {
        const session = sessionsRef.current.find(s => s.id === sid);
        notify({
          type: 'error',
          title: session ? `Session failed: ${session.label}` : 'Session failed',
          message: formatSessionExitMessage(exitInfo.exitCode, exitInfo.signal),
        });
      }
    });
    const removeUpdated = window.electronAPI.session.onUpdated((sid, info) => {
      setSessions(prev => prev.map(s => s.id === sid ? { ...s, ...info } : s));
    });
    // Helm-dispatched children are created in the main process without going
    // through our session.create IPC; this event tells us about them so they
    // appear in the sidebar + get a live xterm instance bound to their PTY.
    const removeCreated = window.electronAPI.session.onCreated((sid, info) => {
      termManager.getOrCreate(sid);
      setSessions(prev => prev.some(s => s.id === sid) ? prev : [...prev, info]);
    });
    return () => { removeData(); removeState(); removeExit(); removeUpdated(); removeCreated(); };
  }, [termManager, notify]);

  const handleCreateSession = useCallback(async (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>, cliArgs?: string[], resumeToolSessionId?: string, profileId?: string, cloneUrl?: string, cliTool?: CreateSessionOptions['cliTool'], customCliBinary?: string, disabledInheritedFlags?: string[], worktreeOf?: string, helmEnabled?: boolean) => {
    const createOpts: CreateSessionOptions = {
      workingDir,
      label: label || undefined,
      environmentId,
      cliTool,
      customCliBinary,
      env,
      cliArgs,
      disabledInheritedFlags,
      resumeToolSessionId,
      resumeClaudeSessionId: !cliTool || cliTool === 'claude' ? resumeToolSessionId : undefined,
      profileId,
      cloneUrl,
      worktreeOf,
      helmEnabled,
    };
    try {
      // If this session would resolve vault:// refs but the Vault token is
      // missing/expired, prompt for login first so the user doesn't have to
      // open Settings, click Log In, click Save, then retry.
      try {
        const preflight = await window.electronAPI.session.vaultPreflight(createOpts);
        if (preflight.needsLogin) {
          const loggedIn = await new Promise<boolean>(resolve => {
            setVaultPrompt({ reason: preflight.reason, onDone: resolve });
          });
          setVaultPrompt(null);
          if (!loggedIn) return; // user cancelled — silent abort
        }
      } catch (preflightErr) {
        // Preflight failure shouldn't block session creation — fall through
        // and let session.create produce its own error if one is warranted.
        console.warn('Vault preflight failed:', preflightErr);
      }
      const session = await window.electronAPI.session.create(createOpts);
      termManager.getOrCreate(session.id);
      setSessions(prev => [...prev, session]);

      const paneId = generatePaneId();
      if (!layoutState.root) {
        const root: LayoutNode = { type: 'leaf', id: paneId, sessionId: session.id };
        layoutDispatch({ type: 'SET_ROOT', root });
        layoutDispatch({ type: 'SET_FOCUS', paneId });
      } else {
        const leaves = getLeaves(layoutState.root);
        const focusedLeaf = layoutState.focusedPaneId
          ? leaves.find(l => l.id === layoutState.focusedPaneId)
          : null;
        const emptyLeaf = focusedLeaf?.sessionId === null
          ? focusedLeaf
          : leaves.find(l => l.sessionId === null);
        const targetPaneId = focusedLeaf?.id ?? leaves[0]?.id;

        if (enablePaneSplitting && emptyLeaf) {
          layoutDispatch({ type: 'REPLACE_SESSION', paneId: emptyLeaf.id, sessionId: session.id });
          layoutDispatch({ type: 'SET_FOCUS', paneId: emptyLeaf.id });
        } else if (!enablePaneSplitting || getLeafCount(layoutState.root) >= effectiveMaxPanes) {
          // Single-pane mode or full constrained layout: replace the focused pane.
          if (targetPaneId) {
            layoutDispatch({ type: 'REPLACE_SESSION', paneId: targetPaneId, sessionId: session.id });
            layoutDispatch({ type: 'SET_FOCUS', paneId: targetPaneId });
          }
        } else if (targetPaneId) {
          layoutDispatch({ type: 'ADD_PANE', targetPaneId, sessionId: session.id, zone: 'right' });
        }
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      notifyError('Failed to create session', err);
    }
  }, [termManager, layoutState.root, layoutState.focusedPaneId, layoutDispatch, notifyError, enablePaneSplitting, effectiveMaxPanes]);

  const handleCreateEnvironment = useCallback(async (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => {
    try {
      const env = await window.electronAPI.environment.create({ name, type, config, envVars });
      setEnvironments(prev => [...prev, env]);
    } catch (err) {
      console.error('Failed to create environment:', err);
      notifyError('Failed to create environment', err);
    }
  }, [notifyError]);

  const handleUpdateEnvironment = useCallback(async (id: string, name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => {
    try {
      await window.electronAPI.environment.update(id, { name, type, config, envVars });
      setEnvironments(prev => prev.map(env =>
        env.id === id ? { ...env, name, type, config, envVars } : env,
      ));
    } catch (err) {
      console.error('Failed to update environment:', err);
      notifyError('Failed to update environment', err);
    }
  }, [notifyError]);

  const handleDeleteEnvironment = useCallback(async (env: EnvironmentInfo) => {
    const envSessions = sessions.filter(s => s.environmentId === env.id);
    const message = envSessions.length > 0
      ? `Delete "${env.name}"? ${envSessions.length} session(s) will be removed.`
      : `Delete "${env.name}"?`;
    const result = await confirmDialog({
      title: 'Delete environment',
      message,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!result.confirmed) return;

    try {
      // Remove associated sessions first
      for (const s of envSessions) {
        markExpectedSessionExit(s.id);
        await window.electronAPI.session.remove(s.id);
        termManager.remove(s.id);
        layoutDispatch({ type: 'REMOVE_SESSION', sessionId: s.id });
      }
      await window.electronAPI.environment.delete(env.id);
      setEnvironments(prev => prev.filter(e => e.id !== env.id));
      setSessions(prev => prev.filter(s => !envSessions.some(es => es.id === s.id)));
    } catch (err) {
      console.error('Failed to delete environment:', err);
      notifyError('Failed to delete environment', err);
    }
  }, [sessions, termManager, layoutDispatch, notifyError, confirmDialog, markExpectedSessionExit]);

  // Close env context menu on outside click
  useEffect(() => {
    if (!envMenuOpenId) return;
    const handleClick = (e: MouseEvent) => {
      if (envMenuRef.current && !envMenuRef.current.contains(e.target as Node)) {
        setEnvMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [envMenuOpenId]);

  const handleStop = useCallback(async (id: string) => {
    markExpectedSessionExit(id);
    try {
      await window.electronAPI.session.stop(id);
    } catch (err) {
      expectedSessionExitIds.current.delete(id);
      notifyError('Failed to stop session', err);
    }
  }, [markExpectedSessionExit, notifyError]);

  const handleKill = useCallback(async (id: string) => {
    markExpectedSessionExit(id);
    try {
      await window.electronAPI.session.kill(id);
    } catch (err) {
      expectedSessionExitIds.current.delete(id);
      notifyError('Failed to kill session', err);
    }
  }, [markExpectedSessionExit, notifyError]);

  const handleRename = useCallback(async (id: string, label: string) => {
    try {
      await window.electronAPI.session.rename(id, label);
      setSessions(prev => prev.map(s => s.id === id ? { ...s, label } : s));
    } catch (err) {
      notifyError('Failed to rename session', err);
    }
  }, [notifyError]);

  const handleRemove = useCallback(async (id: string) => {
    const session = sessions.find(s => s.id === id);
    let removeWorktree = false;

    if (session?.worktreeOf) {
      const result = await confirmDialog({
        title: 'Remove session?',
        message: `Remove session "${session.label}"?`,
        confirmLabel: 'Remove',
        danger: true,
        checkbox: {
          label: `Also remove worktree at ${session.workingDir}`,
          hint: 'Worktree must have no uncommitted changes.',
          defaultChecked: false,
        },
      });
      if (!result.confirmed) return;
      removeWorktree = result.checkboxValue;
    }

    markExpectedSessionExit(id);
    try {
      await window.electronAPI.session.remove(id);
      termManager.remove(id);
      layoutDispatch({ type: 'REMOVE_SESSION', sessionId: id });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      expectedSessionExitIds.current.delete(id);
      notifyError('Failed to remove session', err);
      return;
    }

    if (removeWorktree && session?.worktreeOf) {
      try {
        await window.electronAPI.git.worktreeRemove({
          sourceRepo: session.worktreeOf,
          worktreePath: session.workingDir,
        });
        notify({ type: 'info', title: 'Worktree removed', message: session.workingDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const forceResult = await confirmDialog({
          title: 'Worktree removal failed',
          message: `Could not remove worktree:\n\n${errMsg}\n\nForce remove? This discards any uncommitted changes in the worktree.`,
          confirmLabel: 'Force remove',
          cancelLabel: 'Keep worktree',
          danger: true,
        });
        if (forceResult.confirmed) {
          try {
            await window.electronAPI.git.worktreeRemove({
              sourceRepo: session.worktreeOf,
              worktreePath: session.workingDir,
              force: true,
            });
            notify({ type: 'info', title: 'Worktree force-removed', message: session.workingDir });
          } catch (forceErr) {
            notify({ type: 'error', title: 'Force remove failed', message: forceErr instanceof Error ? forceErr.message : String(forceErr) });
          }
        }
      }
    }
  }, [sessions, termManager, layoutDispatch, confirmDialog, notify, notifyError, markExpectedSessionExit]);

  const handleToggleHelm = useCallback(async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.session.setHelmEnabled(id, enabled);
      setSessions(prev => prev.map(s => s.id === id ? { ...s, helmEnabled: enabled } : s));
    } catch (err) {
      notifyError('Failed to update Helm setting', err);
    }
  }, [notifyError]);

  const handleDuplicate = useCallback(async (id: string) => {
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    const siblingLabels = sessions
      .filter(s => s.workingDir === source.workingDir)
      .map(s => s.label);
    const label = nextDuplicateLabel(source.label, siblingLabels);
    handleCreateSession(source.workingDir, label, source.environmentId || undefined, undefined, undefined, undefined, undefined, undefined, source.cliTool, source.customCliBinary, undefined, undefined, source.helmEnabled);
  }, [sessions, handleCreateSession]);

  const sessionsInGroup = useCallback((environmentId: string, workingDir: string): SessionInfo[] => {
    const env = environments.find(e => e.id === environmentId);
    if (!env) return [];
    return sessions.filter(s => {
      if (s.workingDir !== workingDir) return false;
      if (env.type === 'local') return !s.environmentId || s.environmentId === env.id;
      return s.environmentId === env.id;
    });
  }, [sessions, environments]);

  const removeSessionsLocal = useCallback(async (targets: SessionInfo[]) => {
    for (const s of targets) {
      markExpectedSessionExit(s.id);
      try {
        await window.electronAPI.session.remove(s.id);
        termManager.remove(s.id);
        layoutDispatch({ type: 'REMOVE_SESSION', sessionId: s.id });
      } catch (err) {
        expectedSessionExitIds.current.delete(s.id);
        notifyError(`Failed to remove ${s.label}`, err);
      }
    }
    setSessions(prev => prev.filter(s => !targets.some(t => t.id === s.id)));
  }, [termManager, layoutDispatch, markExpectedSessionExit, notifyError]);

  const recreateFromSnapshot = useCallback((snap: SessionInfo) => {
    handleCreateSession(
      snap.workingDir,
      snap.label,
      snap.environmentId || undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      snap.cliTool,
      snap.customCliBinary,
      undefined,
      snap.worktreeOf,
      snap.helmEnabled,
    );
  }, [handleCreateSession]);

  const handleKillAllInGroup = useCallback(async (environmentId: string, workingDir: string) => {
    const targets = sessionsInGroup(environmentId, workingDir).filter(
      s => s.state === 'running' || s.state === 'starting' || s.state === 'waiting',
    );
    if (targets.length === 0) return;
    for (const s of targets) {
      markExpectedSessionExit(s.id);
      try {
        await window.electronAPI.session.kill(s.id);
      } catch (err) {
        expectedSessionExitIds.current.delete(s.id);
        notifyError(`Failed to kill ${s.label}`, err);
      }
    }
    notify({
      type: 'info',
      title: `Killed ${targets.length} session${targets.length === 1 ? '' : 's'}`,
      ttl: 5000,
    });
  }, [sessionsInGroup, markExpectedSessionExit, notify, notifyError]);

  const handleRestartAllInGroup = useCallback(async (environmentId: string, workingDir: string) => {
    const targets = sessionsInGroup(environmentId, workingDir);
    if (targets.length === 0) return;
    const snapshots = targets.map(s => ({ ...s }));
    await removeSessionsLocal(targets);
    for (const snap of snapshots) {
      recreateFromSnapshot(snap);
    }
    notify({
      type: 'info',
      title: `Restarted ${snapshots.length} session${snapshots.length === 1 ? '' : 's'}`,
      ttl: 5000,
    });
  }, [sessionsInGroup, removeSessionsLocal, recreateFromSnapshot, notify]);

  const handleClearAllInGroup = useCallback(async (environmentId: string, workingDir: string) => {
    const targets = sessionsInGroup(environmentId, workingDir);
    if (targets.length === 0) return;
    const snapshots = targets.map(s => ({ ...s }));
    await removeSessionsLocal(targets);
    notify({
      type: 'info',
      title: `Cleared ${snapshots.length} session${snapshots.length === 1 ? '' : 's'}`,
      ttl: 8000,
      action: {
        label: 'Undo',
        onClick: () => {
          for (const snap of snapshots) recreateFromSnapshot(snap);
        },
      },
    });
  }, [sessionsInGroup, removeSessionsLocal, recreateFromSnapshot, notify]);

  const canResumePrevious = useCallback((session: SessionInfo) => {
    if (!enableResumePicker) return false;
    const cliTool = session.cliTool || 'claude';
    if (!toolSupportsHistory(cliTool)) return false;
    if (!session.environmentId) return true;
    return environmentById.get(session.environmentId)?.type === 'local';
  }, [enableResumePicker, environmentById]);

  const handleOpenResumePicker = useCallback((id: string) => {
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    setResumePickerFor({
      sessionId: id,
      workingDir: source.workingDir,
      cliTool: source.cliTool || 'claude',
      currentTranscriptId: source.toolSessionId || source.claudeSessionId,
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
      undefined,
      undefined,
      source.cliTool,
      source.customCliBinary,
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

      const focusedLeaf = layoutState.focusedPaneId
        ? leaves.find(l => l.id === layoutState.focusedPaneId)
        : null;
      const emptyLeaf = focusedLeaf?.sessionId === null
        ? focusedLeaf
        : leaves.find(l => l.sessionId === null);
      if (emptyLeaf) {
        layoutDispatch({ type: 'REPLACE_SESSION', paneId: emptyLeaf.id, sessionId });
        layoutDispatch({ type: 'SET_FOCUS', paneId: emptyLeaf.id });
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

  // Repo group pin/reorder helpers
  const sortRepoGroups = useCallback((
    entries: [string, SessionInfo[]][],
    envId: string,
  ): [string, SessionInfo[]][] => {
    const envPrefs = repoGroupPrefs.filter(p => p.environmentId === envId);
    const prefMap = new Map(envPrefs.map(p => [p.workingDir, p]));
    return entries.sort((a, b) => {
      const pa = prefMap.get(a[0]);
      const pb = prefMap.get(b[0]);
      const pinnedA = pa?.pinned ?? false;
      const pinnedB = pb?.pinned ?? false;
      if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
      const orderA = pa?.sortOrder ?? Infinity;
      const orderB = pb?.sortOrder ?? Infinity;
      if (orderA !== orderB) return orderA - orderB;
      return a[0].localeCompare(b[0]);
    });
  }, [repoGroupPrefs]);

  const handleTogglePin = useCallback(async (environmentId: string, workingDir: string) => {
    const envPrefs = repoGroupPrefs.filter(p => p.environmentId === environmentId);
    const existing = envPrefs.find(p => p.workingDir === workingDir);
    const newPinned = !(existing?.pinned ?? false);
    let updated: RepoGroupPref[];
    if (existing) {
      updated = envPrefs.map(p =>
        p.workingDir === workingDir ? { ...p, pinned: newPinned } : p,
      );
    } else {
      updated = [...envPrefs, { environmentId, workingDir, pinned: newPinned, sortOrder: envPrefs.length }];
    }
    setRepoGroupPrefs(prev => [
      ...prev.filter(p => p.environmentId !== environmentId),
      ...updated,
    ]);
    try {
      await window.electronAPI.repoGroup.setPrefs(environmentId, updated);
    } catch (err) {
      notifyError('Failed to update repo group', err);
    }
  }, [repoGroupPrefs, notifyError]);

  /**
   * Sort sessions inside a single repo group by the user-saved order. New
   * sessions (not in the prefs list) sink to the bottom, with creation order
   * as the tiebreaker so a fresh session always lands after older ones.
   */
  const sortSessionsInGroup = useCallback((
    envId: string,
    workingDir: string,
    groupSessions: SessionInfo[],
  ): SessionInfo[] => {
    const pref = sessionOrderPrefs.find(p => p.environmentId === envId && p.workingDir === workingDir);
    if (!pref || pref.orderedIds.length === 0) return groupSessions;
    const indexById = new Map(pref.orderedIds.map((id, i) => [id, i]));
    return [...groupSessions].sort((a, b) => {
      const ia = indexById.get(a.id) ?? Infinity;
      const ib = indexById.get(b.id) ?? Infinity;
      if (ia !== ib) return ia - ib;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }, [sessionOrderPrefs]);

  const handleReorderSession = useCallback(async (
    envId: string,
    workingDir: string,
    sourceSessionId: string,
    targetSessionId: string,
    position: 'above' | 'below',
  ) => {
    if (sourceSessionId === targetSessionId) return;
    // Build the current group ordering from live sessions, then move source.
    const groupSessions = sessions.filter(s => {
      if (s.workingDir !== workingDir) return false;
      const env = environments.find(e => e.id === envId);
      if (!env) return false;
      if (env.type === 'local') return !s.environmentId || s.environmentId === env.id;
      return s.environmentId === env.id;
    });
    const sortedIds = sortSessionsInGroup(envId, workingDir, groupSessions).map(s => s.id);
    const without = sortedIds.filter(id => id !== sourceSessionId);
    const targetIdx = without.indexOf(targetSessionId);
    if (targetIdx === -1) return;
    const insertIdx = position === 'above' ? targetIdx : targetIdx + 1;
    without.splice(insertIdx, 0, sourceSessionId);
    setSessionOrderPrefs(prev => [
      ...prev.filter(p => !(p.environmentId === envId && p.workingDir === workingDir)),
      { environmentId: envId, workingDir, orderedIds: without },
    ]);
    try {
      await window.electronAPI.sessionOrder.setPref(envId, workingDir, without);
    } catch (err) {
      notifyError('Failed to reorder sessions', err);
    }
  }, [sessions, environments, sortSessionsInGroup, notifyError]);

  const handleDropRepoGroup = useCallback(async (
    environmentId: string,
    sourceDir: string,
    targetDir: string,
    position: 'above' | 'below',
  ) => {
    // Get current sorted order for this environment
    const envSessions = sessions.filter(s => {
      const env = environments.find(e => e.id === environmentId);
      if (!env) return false;
      if (env.type === 'local') return !s.environmentId || s.environmentId === env.id;
      return s.environmentId === env.id;
    });
    const dirs = [...new Set(envSessions.map(s => s.workingDir))];
    const sorted = sortRepoGroups(
      dirs.map(d => [d, []] as [string, SessionInfo[]]),
      environmentId,
    ).map(([d]) => d);
    // Remove source, insert at target position
    const without = sorted.filter(d => d !== sourceDir);
    const targetIdx = without.indexOf(targetDir);
    const insertIdx = position === 'above' ? targetIdx : targetIdx + 1;
    without.splice(insertIdx, 0, sourceDir);
    // Build updated prefs preserving pinned status
    const envPrefs = repoGroupPrefs.filter(p => p.environmentId === environmentId);
    const updated = without.map((dir, index) => {
      const existing = envPrefs.find(p => p.workingDir === dir);
      return {
        environmentId,
        workingDir: dir,
        pinned: existing?.pinned ?? false,
        sortOrder: index,
      };
    });
    setRepoGroupPrefs(prev => [
      ...prev.filter(p => p.environmentId !== environmentId),
      ...updated,
    ]);
    try {
      await window.electronAPI.repoGroup.setPrefs(environmentId, updated);
    } catch (err) {
      notifyError('Failed to reorder repo groups', err);
    }
  }, [sessions, environments, repoGroupPrefs, sortRepoGroups, notifyError]);

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

  // Window zoom: persist whatever level is set so the next launch matches.
  const setWindowZoom = useCallback((level: number) => {
    const clamped = Math.max(-3, Math.min(3, level));
    window.electronAPI.webFrame.setZoomLevel(clamped);
    window.electronAPI.config.set?.('windowZoomLevel', String(clamped));
  }, []);

  const handleSessionFontSizeChange = useCallback((sessionId: string, delta: number) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      const current = s.fontSize ?? defaultTerminalFontSize;
      const next = Math.max(8, Math.min(32, current + delta));
      return next === current ? s : { ...s, fontSize: next };
    }));
  }, [defaultTerminalFontSize]);

  const handleResetSessionFontSizes = useCallback(() => {
    setSessions(prev => prev.map(s => s.fontSize === undefined ? s : { ...s, fontSize: undefined }));
  }, []);

  // Keyboard shortcuts
  const shortcutActions = useMemo(() => ({
    onNewSession: () => setSessionDialogOpen(true),
    onToggleSidebar: () => setSidebarVisible(v => !v),
    onStopSession: () => { if (activeSessionId) handleStop(activeSessionId); },
    onOpenSettings: () => setSettingsOpen(true),
    onZoomIn: () => setWindowZoom(window.electronAPI.webFrame.getZoomLevel() + 0.5),
    onZoomOut: () => setWindowZoom(window.electronAPI.webFrame.getZoomLevel() - 0.5),
    onZoomReset: () => setWindowZoom(0),
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
  }), [activeSessionId, layoutState.root, layoutState.focusedPaneId, layoutDispatch, termManager, handleStop, setWindowZoom]);

  useKeyboardShortcuts(shortcutActions);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  const isAlive = activeSession
    ? activeSession.state !== 'stopped' && activeSession.state !== 'dead'
    : false;
  const currentLeafCount = getLeafCount(layoutState.root);

  const handleCheckForUpdates = useCallback(async () => {
    try {
      const result = await window.electronAPI.update.check();
      if (result.error) {
        notify({ type: 'error', title: 'Update check failed', message: result.error });
        return;
      }

      if (result.updateAvailable) {
        notify({
          type: 'info',
          title: `Update available: v${result.latestVersion}`,
          message: `A new version of Tether is available (you have v${result.currentVersion}).`,
          action: {
            label: 'View Release',
            onClick: () => window.electronAPI.update.openReleasePage(result.releaseUrl),
          },
        });
      } else {
        notify({ type: 'success', title: 'You\'re up to date', message: `Tether v${result.currentVersion} is the latest version.` });
      }
    } catch (err) {
      notifyError('Update check failed', err);
    }
  }, [notify, notifyError]);

  // Listen for background update check result from main process
  useEffect(() => {
    const cleanup = window.electronAPI.update.onUpdateAvailable((result: UpdateCheckResult) => {
      notify({
        type: 'info',
        title: `Update available: v${result.latestVersion}`,
        message: `A new version of Tether is available (you have v${result.currentVersion}).`,
        action: {
          label: 'View Release',
          onClick: () => window.electronAPI.update.openReleasePage(result.releaseUrl),
        },
      });
    });
    return cleanup;
  }, [notify]);

  // Warn the user before their Vault token expires so they can renew proactively.
  useEffect(() => {
    const cleanup = window.electronAPI.vault.onExpiryWarning(({ expiresAt }) => {
      const minutesLeft = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
      notify({
        type: 'info',
        title: 'Vault token expiring soon',
        message: `Expires in ~${minutesLeft} minutes. Click the Vault pill in the sidebar or renew now.`,
        action: {
          label: 'Renew',
          onClick: () => {
            globalThis.electronAPI.vault.login().catch(notifyVaultAuthError);
          },
        },
      });
    });
    return cleanup;
  }, [notify, notifyVaultAuthError]);

  useEffect(() => {
    const cleanup = window.electronAPI.ssh.onHostVerifyRequest((req: HostVerifyRequest) => {
      // Only show one prompt at a time. If another request arrives while one is
      // pending, auto-reject the newcomer to avoid silently dropping it.
      setHostVerifyRequest(prev => {
        if (prev) {
          window.electronAPI.ssh.respondToHostVerify(req.token, false);
          return prev;
        }
        return req;
      });
    });
    return cleanup;
  }, []);

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
        { label: 'Check for Updates...', onClick: handleCheckForUpdates },
        { separator: true },
        { label: 'About Tether', onClick: () => setAboutOpen(true) },
      ],
    },
  ], [activeSessionId, activeSession, isAlive, layoutState.root, themeName, setTheme, handleStop, handleKill, handleRemove, handleDuplicate, shortcutActions, handleCheckForUpdates]);

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
                  onKeyDown={onKeyActivate(() => toggleGroup(env.id))}
                  role="button"
                  tabIndex={0}
                  onContextMenu={e => { e.preventDefault(); setEnvMenuOpenId(prev => prev === env.id ? null : env.id); }}
                  style={{ cursor: 'pointer', position: 'relative' }}
                >
                  <span>
                    {isCollapsed ? '\u25b6' : '\u25bc'} {env.name}
                    {runningCount > 0 && (
                      <span className="env-group-active"> {runningCount} active</span>
                    )}
                  </span>
                  <span className="env-group-count">({envSessions.length})</span>
                  {envMenuOpenId === env.id && (
                    <div ref={envMenuRef} className="context-menu" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="menu" tabIndex={-1}>
                      <div
                        className="context-menu-item"
                        role="menuitem"
                        tabIndex={0}
                        onClick={() => { setEnvMenuOpenId(null); setEditingEnv(env); setEnvDialogOpen(true); }}
                        onKeyDown={onKeyActivate(() => { setEnvMenuOpenId(null); setEditingEnv(env); setEnvDialogOpen(true); })}
                      >
                        Edit
                      </div>
                      <div
                        className="context-menu-item context-menu-item--danger"
                        role="menuitem"
                        tabIndex={0}
                        onClick={() => { setEnvMenuOpenId(null); handleDeleteEnvironment(env); }}
                        onKeyDown={onKeyActivate(() => { setEnvMenuOpenId(null); handleDeleteEnvironment(env); })}
                      >
                        Delete
                      </div>
                    </div>
                  )}
                </div>
                {!isCollapsed && envSessions.length > 0 && (
                  (() => {
                    const byDir = new Map<string, SessionInfo[]>();
                    for (const s of envSessions) {
                      const dir = s.workingDir;
                      if (!byDir.has(dir)) byDir.set(dir, []);
                      byDir.get(dir)!.push(s);
                    }
                    const sortedEntries = sortRepoGroups(Array.from(byDir.entries()), env.id);
                    return sortedEntries.map(([dir, dirSessions]) => (
                      <RepoGroup
                        key={dir}
                        repoPath={dir}
                        environmentId={env.id}
                        sessions={sortSessionsInGroup(env.id, dir, dirSessions)}
                        activeSessionId={activeSessionId}
                        pinned={repoGroupPrefs.find(p => p.environmentId === env.id && p.workingDir === dir)?.pinned ?? false}
                        onTogglePin={handleTogglePin}
                        onDropRepoGroup={handleDropRepoGroup}
                        onSelectSession={handleSelectSession}
                        onStop={handleStop}
                        onKill={handleKill}
                        onRename={handleRename}
                        onRemove={handleRemove}
                        onDuplicate={handleDuplicate}
                        onResumePrevious={handleOpenResumePicker}
                        canResumePrevious={canResumePrevious}
                        showResumeBadge={showResumeBadge}
                        allowHelm={allowHelm}
                        onToggleHelm={handleToggleHelm}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onReorderSession={handleReorderSession}
                        onKillAllInGroup={handleKillAllInGroup}
                        onRestartAllInGroup={handleRestartAllInGroup}
                        onClearAllInGroup={handleClearAllInGroup}
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
        <GlobalUsageFooter environments={environments} onOpenHistory={() => setUsageHistoryOpen(true)} />
        <QuotaFooter />
        <VaultStatusPill onAuthError={notifyVaultAuthError} />
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
            currentLeafCount={currentLeafCount}
            maxPanes={effectiveMaxPanes}
            defaultFontSize={defaultTerminalFontSize}
            onFontSizeDelta={handleSessionFontSizeChange}
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
        onClose={() => { setEnvDialogOpen(false); setEditingEnv(null); }}
        onCreate={handleCreateEnvironment}
        editing={editingEnv}
        onUpdate={handleUpdateEnvironment}
      />
      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          window.electronAPI.profile.list().then(setProfiles).catch(() => {});
        }}
        currentTheme={themeName}
        onThemeChange={setTheme}
        onResetSessionFontSizes={handleResetSessionFontSizes}
      />
      <KeyboardShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <UsageHistoryDialog
        isOpen={usageHistoryOpen}
        onClose={() => setUsageHistoryOpen(false)}
      />
      <AboutDialog
        isOpen={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />
      <HostKeyVerifyDialog
        request={hostVerifyRequest}
        onTrust={() => {
          if (hostVerifyRequest) {
            window.electronAPI.ssh.respondToHostVerify(hostVerifyRequest.token, true);
          }
          setHostVerifyRequest(null);
        }}
        onReject={() => {
          if (hostVerifyRequest) {
            window.electronAPI.ssh.respondToHostVerify(hostVerifyRequest.token, false);
          }
          setHostVerifyRequest(null);
        }}
      />
      <SetupWizard isOpen={setupWizardOpen} onClose={handleSetupWizardClose} />
      {resumePickerFor && (
        <ResumeChatDialog
          isOpen={true}
          workingDir={resumePickerFor.workingDir}
          cliTool={resumePickerFor.cliTool || 'claude'}
          currentTranscriptId={resumePickerFor.currentTranscriptId}
          onClose={() => setResumePickerFor(null)}
          onPick={handlePickResume}
        />
      )}
      <VaultLoginPromptDialog
        isOpen={!!vaultPrompt}
        reason={vaultPrompt?.reason}
        onLoginSuccess={() => vaultPrompt?.onDone(true)}
        onCancel={() => vaultPrompt?.onDone(false)}
      />
      <Notifications notifications={notifications} onDismiss={dismiss} />
      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}

function withHiddenXtermCursor(theme: ITheme): ITheme {
  const background = theme.background ?? '#000000';
  return {
    ...theme,
    cursor: background,
    cursorAccent: theme.foreground ?? background,
  };
}

function parseMaxPanes(value: string | null | undefined): number {
  const parsed = Number(value);
  return clampMaxPanes(Number.isFinite(parsed) ? parsed : 4);
}
