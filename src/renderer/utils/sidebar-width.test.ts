import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth, defaultSidebarWidth, parseSavedSidebarWidth,
} from './sidebar-width';

describe('sidebar width', () => {
  it('clamps to the shared bounds at both extremes', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(301.6)).toBe(302);
  });

  it('follows the interface density until the user chooses a width', () => {
    expect(defaultSidebarWidth('compact')).toBe(220);
    expect(defaultSidebarWidth('comfortable')).toBe(260);
  });

  it('restores a saved width and ignores anything unusable', () => {
    expect(parseSavedSidebarWidth('340')).toBe(340);
    expect(parseSavedSidebarWidth('9999')).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseSavedSidebarWidth('12')).toBe(SIDEBAR_MIN_WIDTH);
    for (const value of [null, undefined, '', '  ', 'wide', 'NaN']) {
      expect(parseSavedSidebarWidth(value)).toBeNull();
    }
  });
});
