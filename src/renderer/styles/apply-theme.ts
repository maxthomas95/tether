import type { TetherTheme } from '../../shared/theme-types';

export function applyDocumentTheme(theme: TetherTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.name;
  root.style.colorScheme = theme.isDark ? 'dark' : 'light';
  for (const [property, value] of Object.entries(theme.css)) root.style.setProperty(property, value);
  root.style.setProperty('--inner-highlight', theme.isDark ? 'inset 0 1px 0 rgba(255, 255, 255, 0.04)' : '0 0 0 0 transparent');
}
