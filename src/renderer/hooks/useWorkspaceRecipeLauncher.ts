import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import type { WorkspaceRecipeLaunchResult, WorkspaceRecipeOpenPlan } from '../../shared/workspace-recipes';
import { extractErrorMessage } from '../utils/errors';

interface Dependencies {
  registerSession(session: SessionInfo): void;
  requestVaultLogin(reason?: string): Promise<boolean>;
}

/** Cancellation stops future launches; a completed in-flight creation always stays registered. */
export function useWorkspaceRecipeLauncher(dependencies: Dependencies) {
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const running = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => { cancelled.current = true; }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelled.current = true; };
  }, []);

  const launch = useCallback(async (
    plan: WorkspaceRecipeOpenPlan, previousSessionIds: Array<string | null> = [],
  ): Promise<WorkspaceRecipeLaunchResult> => {
    if (running.current) throw new Error('A workspace is already opening');
    running.current = true;
    cancelled.current = false;
    setBusy(true);
    const sessionIds = Array.from({ length: plan.sessionCount }, (_, i) => previousSessionIds[i] ?? null);
    const failures: WorkspaceRecipeLaunchResult['failures'] = [];
    try {
      for (const { sessionIndex, options } of plan.sessions) {
        if (cancelled.current) break;
        if (sessionIds[sessionIndex]) continue;
        try {
          const preflight = await window.electronAPI.session.vaultPreflight(options);
          if (cancelled.current) break;
          if (preflight.needsLogin) {
            const loggedIn = await dependenciesRef.current.requestVaultLogin(preflight.reason);
            if (!loggedIn) cancelled.current = true;
          }
          if (cancelled.current) break;
          const session = await window.electronAPI.session.create(options);
          sessionIds[sessionIndex] = session.id;
          dependenciesRef.current.registerSession(session);
        } catch (error) {
          failures.push({ sessionIndex, label: options.label, error: extractErrorMessage(error) });
        }
      }
      return { sessionIds, failures, cancelled: cancelled.current };
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, launch, cancel };
}
