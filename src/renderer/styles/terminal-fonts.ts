// Mirrors --font-mono-terminal in tokens.css. An empty saved preset selects
// this default, even while App is still applying the previous CSS variable.
export const DEFAULT_TERMINAL_FONT = "'Cascadia Code', 'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace";

export function loadTerminalFont(family: string): Promise<unknown> {
  return document.fonts?.load(`14px ${family}`) ?? Promise.resolve();
}
