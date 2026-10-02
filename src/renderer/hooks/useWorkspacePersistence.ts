import { useCallback, useEffect, useState } from 'react';
import type { SavedCanvas } from '../../shared/canvas-types';
import type { SessionInfo, TetherAPI } from '../../shared/types';

export type SavedWorkspaceSession = Parameters<TetherAPI['workspace']['save']>[0][number];

/** Keep failed restore entries recoverable until the user explicitly forgets them. */
export function useWorkspacePersistence(
  sessions: SessionInfo[],
  activeSessionId: string | null,
  canvas: SavedCanvas | undefined,
  ready: boolean,
) {
  const [failedSessions, setFailedSessions] = useState<SavedWorkspaceSession[]>([]);
  const retainFailedSessions = useCallback((saved: SavedWorkspaceSession[]) => {
    setFailedSessions(saved.map(session => ({ ...session, restorePending: true })));
  }, []);
  const forgetFailedSessions = useCallback(() => setFailedSessions([]), []);

  useEffect(() => {
    if (!ready) return;
    const activeIndex = sessions.findIndex(session => session.id === activeSessionId);
    const current: SavedWorkspaceSession[] = sessions.map(session => ({
      workingDir: session.workingDir,
      label: session.label,
      environmentId: session.environmentId || undefined,
      cliTool: session.cliTool,
      customCliBinary: session.customCliBinary,
      toolSessionId: session.toolSessionId || session.claudeSessionId,
      claudeSessionId: session.claudeSessionId,
      worktreeOf: session.worktreeOf,
      helmEnabled: session.helmEnabled,
      parentSessionId: session.parentSessionId,
      launchSnapshotId: session.launchSnapshotId,
    }));
    // Current sessions stay first so Canvas session indices retain their meaning.
    void window.electronAPI.workspace?.save?.([...current, ...failedSessions], Math.max(0, activeIndex), canvas);
  }, [sessions, activeSessionId, canvas, ready, failedSessions]);

  return { retainFailedSessions, forgetFailedSessions };
}
