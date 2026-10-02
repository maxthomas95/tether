import { useCallback, useEffect, useState } from 'react';
import type { SavedCanvas } from '../../shared/canvas-types';
import type { SessionInfo, TetherAPI } from '../../shared/types';
import type { NotifyOptions } from '../components/Notifications';
import type { ConfirmOptions } from '../components/ConfirmDialog';

export type SavedWorkspaceSession = Parameters<TetherAPI['workspace']['save']>[0][number];
export interface WorkspaceRestoreFailure { label: string; error: string; saved: SavedWorkspaceSession }
interface RecoveryUI {
  notify: (options: NotifyOptions) => string;
  confirm: (options: ConfirmOptions) => Promise<{ confirmed: boolean; checkboxValue: boolean }>;
}

/** Keep failed restore entries recoverable until the user explicitly forgets them. */
export function useWorkspacePersistence(
  sessions: SessionInfo[],
  activeSessionId: string | null,
  canvas: SavedCanvas | undefined,
  ready: boolean,
  recovery: RecoveryUI,
) {
  const [failedSessions, setFailedSessions] = useState<SavedWorkspaceSession[]>([]);
  const retainFailedSessions = useCallback((saved: SavedWorkspaceSession[]) => {
    setFailedSessions(saved.map(session => ({ ...session, restorePending: true })));
  }, []);
  const forgetFailedSessions = useCallback(() => setFailedSessions([]), []);
  const { notify, confirm } = recovery;
  const forgetAction = useCallback(() => {
    void confirm({
      title: 'Forget failed sessions?',
      message: 'Remove the sessions that failed to restore from the saved workspace? They will no longer be retried on launch.',
      confirmLabel: 'Forget sessions',
      danger: true,
    }).then(result => { if (result.confirmed) forgetFailedSessions(); });
  }, [confirm, forgetFailedSessions]);

  const reportRestoreFailures = useCallback((failures: WorkspaceRestoreFailure[]) => {
    if (!failures.length) return;
    retainFailedSessions(failures.map(failure => failure.saved));
    const first = failures[0];
    notify({
      type: 'error',
      title: failures.length === 1 ? `Failed to restore ${first.label}` : `Failed to restore ${failures.length} sessions`,
      message: `${first.error}. Saved entries will be retried on the next launch.`,
      action: { label: 'Forget failed sessions', onClick: forgetAction },
    });
  }, [notify, retainFailedSessions, forgetAction]);

  const retainPendingRestores = useCallback((saved: SavedWorkspaceSession[]) => {
    const pending = saved.filter(session => session.restorePending);
    if (!pending.length) return;
    retainFailedSessions(pending);
    notify({
      type: 'warning',
      title: `${pending.length} saved sessions awaiting restore`,
      message: 'These entries will be retried on the next app launch.',
      action: { label: 'Forget failed sessions', onClick: forgetAction },
    });
  }, [notify, retainFailedSessions, forgetAction]);

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

  return { retainFailedSessions, forgetFailedSessions, reportRestoreFailures, retainPendingRestores };
}
