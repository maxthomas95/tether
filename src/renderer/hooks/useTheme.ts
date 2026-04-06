import { useState, useEffect, useCallback, useRef } from 'react';
import { getTheme, DEFAULT_THEME, type TetherTheme } from '../styles/themes';
import type { ITheme } from '@xterm/xterm';

export function useTheme() {
  const [themeName, setThemeNameState] = useState(DEFAULT_THEME);
  const themeRef = useRef<TetherTheme>(getTheme(DEFAULT_THEME));

  // Apply CSS variables to document root + update titlebar overlay
  const applyTheme = useCallback((theme: TetherTheme) => {
    const root = document.documentElement;
    for (const [prop, value] of Object.entries(theme.css)) {
      root.style.setProperty(prop, value);
    }
    window.electronAPI.titlebar.updateOverlay(
      theme.titlebar.color,
      theme.titlebar.symbolColor,
    );
  }, []);

  // Load saved theme on mount
  useEffect(() => {
    window.electronAPI.config.get('theme').then((saved) => {
      const name = saved || DEFAULT_THEME;
      const theme = getTheme(name);
      themeRef.current = theme;
      setThemeNameState(name);
      applyTheme(theme);
    });
  }, [applyTheme]);

  // Set + persist theme
  const setTheme = useCallback((name: string) => {
    const theme = getTheme(name);
    themeRef.current = theme;
    setThemeNameState(name);
    applyTheme(theme);
    window.electronAPI.config.set('theme', name);
  }, [applyTheme]);

  const xtermTheme: ITheme = themeRef.current.xterm;

  return { themeName, setTheme, xtermTheme };
}
