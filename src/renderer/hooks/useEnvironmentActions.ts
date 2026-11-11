import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { EnvironmentInfo, EnvironmentType } from '../../shared/types';

/**
 * Create/update handlers for the environment dialog. Each resolves `true`
 * only when the change was saved, so the dialog can stay open (with the
 * user's input intact) after a failure.
 */
export function useEnvironmentActions(
  setEnvironments: Dispatch<SetStateAction<EnvironmentInfo[]>>,
  notifyError: (title: string, err: unknown) => void,
) {
  const handleCreateEnvironment = useCallback(async (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>): Promise<boolean> => {
    try {
      const env = await window.electronAPI.environment.create({ name, type, config, envVars });
      setEnvironments(prev => [...prev, env]);
      return true;
    } catch (err) {
      console.error('Failed to create environment:', err);
      notifyError('Failed to create environment', err);
      return false;
    }
  }, [setEnvironments, notifyError]);

  const handleUpdateEnvironment = useCallback(async (id: string, name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>): Promise<boolean> => {
    try {
      await window.electronAPI.environment.update(id, { name, type, config, envVars });
      setEnvironments(prev => prev.map(env =>
        env.id === id ? { ...env, name, type, config, envVars } : env,
      ));
      return true;
    } catch (err) {
      console.error('Failed to update environment:', err);
      notifyError('Failed to update environment', err);
      return false;
    }
  }, [setEnvironments, notifyError]);

  return { handleCreateEnvironment, handleUpdateEnvironment };
}
