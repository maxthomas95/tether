import { useState, useEffect, useCallback, useRef } from 'react';
import { getTheme, DEFAULT_THEME, type TetherTheme } from '../styles/themes';
import type { ITheme } from '@xterm/xterm';

export function useTheme(onError?: (title: string, error: unknown) => void) {
  const [themeName, setThemeNameState] = useState(DEFAULT_THEME);
  const themeRef = useRef<TetherTheme>(getTheme(DEFAULT_THEME));

  // Apply CSS variables to document root + update titlebar overlay.
  // The data-theme attribute is the seam for surface tokens defined in
  // tokens.css; everything else is injected inline below.
  const applyTheme = useCallback((theme: TetherTheme) => {
    const root = document.documentElement;
    root.dataset.theme = theme.name;
    root.style.colorScheme = theme.isDark ? 'dark' : 'light';
    for (const [prop, value] of Object.entries(theme.css)) {
      root.style.setProperty(prop, value);
    }
    window.electronAPI.titlebar.updateOverlay(
      theme.titlebar.color,
      theme.titlebar.symbolColor,
    ).catch(() => {});
  }, []);

  // Load saved theme on mount
  useEffect(() => {
    let mounted = true;
    window.electronAPI.config.get('theme').then((saved) => {
      if (!mounted) return;
      const name = saved || DEFAULT_THEME;
      const theme = getTheme(name);
      themeRef.current = theme;
      setThemeNameState(name);
      applyTheme(theme);
    }).catch(() => {
      if (mounted) applyTheme(themeRef.current);
    });
    return () => { mounted = false; };
  }, [applyTheme]);

  // Settings can preview without committing; Cancel restores the opening theme.
  const previewTheme = useCallback((name: string) => {
    const theme = getTheme(name);
    themeRef.current = theme;
    setThemeNameState(name);
    applyTheme(theme);
  }, [applyTheme]);

  const setTheme = useCallback((name: string) => {
    previewTheme(name);
    window.electronAPI.config.set('theme', name).catch(error => onError?.('Could not save the theme', error));
  }, [previewTheme, onError]);

  const xtermTheme: ITheme = themeRef.current.xterm;

  return { themeName, setTheme, previewTheme, xtermTheme };
}
