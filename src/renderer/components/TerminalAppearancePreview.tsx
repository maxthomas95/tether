import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTheme } from '../styles/themes';
import { DEFAULT_TERMINAL_FONT } from '../styles/terminal-fonts';
import '@xterm/xterm/css/xterm.css';

interface TerminalAppearancePreviewProps {
  themeName: string;
  fontFamily: string;
  fontSize: number;
}

const SAMPLE = [
  '~/tether/src  main',
  '0O 1lI  {} [] ()  != <= =>',
  '\x1b[1mBold\x1b[0m  \x1b[3mItalic\x1b[0m  Regular',
  '┌──────────────┐',
  '│ columns align│',
  '└──────────────┘',
  Array.from({ length: 8 }, (_, i) => `\x1b[${30 + i}m Aa \x1b[0m`).join(''),
  Array.from({ length: 8 }, (_, i) => `\x1b[${90 + i}m Aa \x1b[0m`).join(''),
].join('\r\n');

export function TerminalAppearancePreview({ themeName, fontFamily, fontSize }: Readonly<TerminalAppearancePreviewProps>) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const family = fontFamily || DEFAULT_TERMINAL_FONT;
    let cancelled = false;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;

    // Measure the chosen face after it loads, rather than a fallback font.
    const fontsReady = document.fonts
      ? Promise.all(['', 'bold ', 'italic ', 'bold italic '].map(style => document.fonts.load(`${style}${fontSize}px ${family}`)))
      : Promise.resolve();
    void fontsReady.catch(() => {}).then(() => {
      if (cancelled) return;
      terminal = new Terminal({
        fontFamily: family,
        fontSize,
        rows: 8,
        cols: 30,
        theme: getTheme(themeName).xterm,
        disableStdin: true,
        scrollback: 0,
        cursorBlink: false,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      // This is a static specimen, independent of sessions and their PTYs.
      terminal.write(`\x1b[?25l${SAMPLE}`);
      const fit = () => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fitAddon.fit();
      };
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(container);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      terminal?.dispose();
    };
  }, [themeName, fontFamily, fontSize]);

  return (
    <div className="form-group">
      <div className="form-label">Font preview</div>
      <div
        className="terminal-appearance-preview"
        role="img"
        aria-label="Terminal font sample with paths, distinguishable characters, bold and italic text, aligned box drawing, and sixteen ANSI colors"
      >
        <div ref={containerRef} style={{ height: Math.ceil(fontSize * 1.3 * 9) }} aria-hidden="true" />
      </div>
      <p className="form-hint">Preview uses your selected theme. Font and size changes apply to sessions when you save.</p>
    </div>
  );
}
