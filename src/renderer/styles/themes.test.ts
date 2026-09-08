import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { themes } from './themes';
import { LOADER_THEMES } from '../../shared/loader-themes';

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('readable and consistent theme chrome', () => {
  for (const theme of Object.values(themes)) {
    it(`${theme.label} keeps informative muted text readable on workspace and sidebar`, () => {
      for (const background of ['--bg-primary', '--bg-sidebar'] as const) {
        const a = luminance(theme.css['--text-muted']), b = luminance(theme.css[background]);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme.label} starts in the same palette as the mounted renderer`, () => {
      const loader = LOADER_THEMES[theme.name];
      expect(loader.bg).toBe(theme.css['--bg-primary']);
      expect(loader.sidebar).toBe(theme.css['--bg-sidebar']);
      expect(loader.text).toBe(theme.css['--text-primary']);
      expect(loader.muted).toBe(theme.css['--text-muted']);
      expect(loader.accent).toBe(theme.css['--accent']);
    });
  }

  for (const file of ['index.html', 'docs-window.html']) {
    it(`authorizes the ${file} boot script with its exact CSP hash`, () => {
      const html = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
      const hash = createHash('sha256').update(script).digest('base64');
      expect(html).toContain(`script-src 'self' 'sha256-${hash}'`);
    });
  }
});
