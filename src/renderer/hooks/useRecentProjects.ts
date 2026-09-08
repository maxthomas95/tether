import { useEffect, useRef, useState } from 'react';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import { mergeRecentProjects, parseRecentProjects, type RecentProject } from '../utils/recent-projects';

export function useRecentProjects(sessions: SessionInfo[], environments: EnvironmentInfo[]) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seenSessions = useRef(new Set<string>());
  const projectsRef = useRef<RecentProject[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.config.get('uiRecentProjects').then(value => {
      if (cancelled) return;
      projectsRef.current = parseRecentProjects(value);
      setProjects(projectsRef.current);
    }).catch(() => {}).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded || environments.length === 0) return;
    const incoming: RecentProject[] = [];
    for (const session of sessions) {
      if (seenSessions.current.has(session.id)) continue;
      const env = session.environmentId
        ? environments.find(e => e.id === session.environmentId)
        : environments.find(e => e.type === 'local');
      // A Coder working directory does not identify the workspace required by its launcher.
      if (!env || env.type === 'coder' || !session.workingDir.trim()) continue;
      seenSessions.current.add(session.id);
      incoming.unshift({ environmentId: env.id, workingDir: session.workingDir });
    }
    if (!incoming.length) return;
    const next = mergeRecentProjects(projectsRef.current, incoming);
    if (JSON.stringify(next) === JSON.stringify(projectsRef.current)) return;
    projectsRef.current = next;
    setProjects(next);
    void window.electronAPI.config.set('uiRecentProjects', JSON.stringify(next)).catch(() => {});
  }, [loaded, sessions, environments]);

  return projects.filter(project => environments.some(e => e.id === project.environmentId && e.type !== 'coder'));
}
