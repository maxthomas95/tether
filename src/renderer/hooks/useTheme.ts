import { useState, useEffect, useCallback, useRef } from 'react';
import { getTheme, DEFAULT_THEME, setLocalThemes, themeList, type TetherTheme } from '../styles/themes';
import { applyDocumentTheme } from '../styles/apply-theme';
import type { LocalThemeCatalog } from '../../shared/theme-types';
import type { ITheme } from '@xterm/xterm';

export function useTheme(onError?: (title: string, error: unknown) => void) {
  const [themeName, setThemeNameState] = useState(DEFAULT_THEME);
  const themeRef = useRef<TetherTheme>(getTheme(DEFAULT_THEME));
  const [availableThemes, setAvailableThemes] = useState(themeList);
  const [localThemeCatalog, setLocalThemeCatalog] = useState<LocalThemeCatalog>({ directory: '', themes: [], issues: [] });
  const mounted = useRef(true);

  // Every surface and the terminal palette come from the same definition.
  const applyTheme = useCallback((theme: TetherTheme) => {
    applyDocumentTheme(theme);
    window.electronAPI.titlebar.updateOverlay(
      theme.titlebar.color,
      theme.titlebar.symbolColor,
    ).catch(() => {});
  }, []);

  const installCatalog = useCallback((catalog: LocalThemeCatalog) => {
    setLocalThemes(catalog.themes);
    setAvailableThemes(themeList);
    setLocalThemeCatalog(catalog);
  }, []);

  // Load saved theme on mount
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    Promise.all([window.electronAPI.config.get('theme'), window.electronAPI.themes.list()]).then(([saved, catalog]) => {
      if (cancelled) return;
      installCatalog(catalog);
      const name = saved || DEFAULT_THEME;
      const theme = getTheme(name);
      themeRef.current = theme;
      setThemeNameState(theme.name);
      applyTheme(theme);
    }).catch(() => {
      if (!cancelled) applyTheme(themeRef.current);
    });
    return () => { cancelled = true; mounted.current = false; };
  }, [applyTheme, installCatalog]);

  // Settings can preview without committing; Cancel restores the opening theme.
  const previewTheme = useCallback((name: string) => {
    const theme = getTheme(name);
    themeRef.current = theme;
    setThemeNameState(theme.name);
    applyTheme(theme);
  }, [applyTheme]);

  const setTheme = useCallback((name: string) => {
    previewTheme(name);
    window.electronAPI.config.set('theme', getTheme(name).name).catch(error => onError?.('Could not save the theme', error));
  }, [previewTheme, onError]);

  const reloadThemes = useCallback(async () => {
    const catalog = await window.electronAPI.themes.reload();
    if (!mounted.current) return;
    installCatalog(catalog);
    previewTheme(themeRef.current.name);
  }, [installCatalog, previewTheme]);

  const xtermTheme: ITheme = themeRef.current.xterm;

  return { themeName, setTheme, previewTheme, xtermTheme, themeList: availableThemes, localThemeCatalog, reloadThemes };
}
