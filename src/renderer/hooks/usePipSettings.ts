import { useCallback, useEffect, useRef, useState } from 'react';
import { PIP_SETTINGS_KEY, readPipSettings, type PipSettings } from '../lib/pip-settings';

export function usePipSettings(onError: (title: string, error: unknown) => void) {
  const [settings, setSettings] = useState<PipSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<PipSettings | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.config.get(PIP_SETTINGS_KEY).then(raw => {
      if (cancelled) return;
      current.current = readPipSettings(raw);
      setSettings(current.current);
    }).catch(error => {
      if (!cancelled) onError('Could not load Pip preferences', error);
    });
    return () => { cancelled = true; };
  }, [onError]);

  const update = useCallback(async (patch: Partial<PipSettings>) => {
    if (!current.current || saving.current) return;
    saving.current = true;
    setBusy(true);
    const next = readPipSettings(JSON.stringify({ ...current.current, ...patch }));
    try {
      await window.electronAPI.config.set(PIP_SETTINGS_KEY, JSON.stringify(next));
      current.current = next;
      setSettings(next);
    } catch (error) {
      onError('Could not save Pip preferences', error);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [onError]);

  const toggle = useCallback(() => update({ enabled: !current.current?.enabled }), [update]);
  return { settings, busy, update, toggle };
}
