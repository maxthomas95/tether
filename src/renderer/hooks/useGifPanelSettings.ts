import { useCallback, useEffect, useState } from 'react';
import type { GifPanelSettings } from '../../shared/gif-panel';

export function useGifPanelSettings(onError: (title: string, error: unknown) => void) {
  const [settings, setSettings] = useState<GifPanelSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    globalThis.electronAPI.gifPanel?.getSettings().then(value => {
      if (!cancelled) setSettings(value);
    }).catch(error => {
      if (!cancelled) onError('Could not load GIF panel settings', error);
    });
    return () => { cancelled = true; };
  }, [onError]);

  const toggle = useCallback(async () => {
    if (!settings) return;
    try {
      setSettings(await globalThis.electronAPI.gifPanel.updateSettings({ enabled: !settings.enabled }));
    } catch (error) {
      onError('Could not update GIF panel settings', error);
    }
  }, [settings, onError]);

  return { settings, setSettings, toggle };
}
