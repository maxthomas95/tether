import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import { mergeRecentProjects, parseRecentProjects, type RecentProject } from '../utils/recent-projects';

function sameProject(a: RecentProject, b: RecentProject) {
  return a.environmentId === b.environmentId && a.workingDir === b.workingDir;
}

export function useRecentProjects(sessions: SessionInfo[], environments: EnvironmentInfo[]) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seenSessions = useRef(new Set<string>());
  const projectsRef = useRef<RecentProject[]>([]);
  const dismissedRef = useRef<RecentProject[]>([]);
  const requestedSessions = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.config.get('uiRecentProjects').catch(() => null),
      window.electronAPI.config.get('uiDismissedRecentProjects').catch(() => null),
    ]).then(([value, dismissed]) => {
      if (cancelled) return;
      // Dismissals outlive the six visible shortcuts and automatic workspace restores.
      dismissedRef.current = parseRecentProjects(dismissed, Infinity);
      projectsRef.current = parseRecentProjects(value).filter(project =>
        !dismissedRef.current.some(row => sameProject(row, project)));
      setProjects(projectsRef.current);
    }).catch(() => {}).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded || environments.length === 0) return;
    const incoming: RecentProject[] = [];
    let dismissalsChanged = false;
    for (const session of sessions) {
      if (seenSessions.current.has(session.id)) continue;
      const env = session.environmentId
        ? environments.find(e => e.id === session.environmentId)
        : environments.find(e => e.type === 'local');
      // A Coder working directory does not identify the workspace required by its launcher.
      if (!env || env.type === 'coder' || !session.workingDir.trim()) continue;
      seenSessions.current.add(session.id);
      const project = { environmentId: env.id, workingDir: session.workingDir };
      const requested = requestedSessions.current.delete(session.id);
      if (dismissedRef.current.some(row => sameProject(row, project))) {
        if (!requested) continue;
        dismissedRef.current = dismissedRef.current.filter(row => !sameProject(row, project));
        dismissalsChanged = true;
      }
      incoming.unshift(project);
    }
    if (dismissalsChanged) {
      void window.electronAPI.config.set('uiDismissedRecentProjects', JSON.stringify(dismissedRef.current)).catch(() => {});
    }
    if (!incoming.length) return;
    const next = mergeRecentProjects(projectsRef.current, incoming);
    if (JSON.stringify(next) === JSON.stringify(projectsRef.current)) return;
    projectsRef.current = next;
    setProjects(next);
    void window.electronAPI.config.set('uiRecentProjects', JSON.stringify(next)).catch(() => {});
  }, [loaded, sessions, environments]);

  const dismissProject = useCallback((project: RecentProject) => {
    const next = projectsRef.current.filter(row => !sameProject(row, project));
    if (next.length === projectsRef.current.length) return;
    dismissedRef.current = mergeRecentProjects(dismissedRef.current, [project], Infinity);
    projectsRef.current = next;
    setProjects(next);
    void window.electronAPI.config.set('uiDismissedRecentProjects', JSON.stringify(dismissedRef.current)).catch(() => {});
    void window.electronAPI.config.set('uiRecentProjects', JSON.stringify(next)).catch(() => {});
  }, []);

  // Only an explicit launch can bring back a dismissed shortcut. Restoring a
  // workspace also creates new session IDs, so new IDs alone are insufficient.
  const recordSession = useCallback((sessionId: string) => {
    requestedSessions.current.add(sessionId);
    seenSessions.current.delete(sessionId);
  }, []);

  return {
    recentProjects: projects.filter(project => environments.some(e => e.id === project.environmentId && e.type !== 'coder')),
    dismissProject,
    recordSession,
  };
}
