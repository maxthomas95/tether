import { describe, expect, it } from 'vitest';
import {
  CHILD_AGENT_PANEL_MAX_WIDTH,
  CHILD_AGENT_PANEL_MIN_WIDTH,
  clampChildAgentPanelWidth,
  isLongTask,
  parseSavedChildAgentPanelWidth,
} from './child-agent-panel';

describe('subagent panel width', () => {
  it('keeps a dragged width inside the bounds and on a whole pixel', () => {
    expect(clampChildAgentPanelWidth(10)).toBe(CHILD_AGENT_PANEL_MIN_WIDTH);
    expect(clampChildAgentPanelWidth(5000)).toBe(CHILD_AGENT_PANEL_MAX_WIDTH);
    expect(clampChildAgentPanelWidth(412.6)).toBe(413);
  });

  it('reads back a saved width, clamped, and ignores anything unusable', () => {
    expect(parseSavedChildAgentPanelWidth('420')).toBe(420);
    expect(parseSavedChildAgentPanelWidth('90')).toBe(CHILD_AGENT_PANEL_MIN_WIDTH);
    expect(parseSavedChildAgentPanelWidth('wide')).toBeNull();
    expect(parseSavedChildAgentPanelWidth('  ')).toBeNull();
    expect(parseSavedChildAgentPanelWidth(null)).toBeNull();
    expect(parseSavedChildAgentPanelWidth(undefined)).toBeNull();
  });
});

describe('isLongTask', () => {
  it('folds a task with many lines or a lot of text, and leaves a brief one open', () => {
    expect(isLongTask('Count the widgets')).toBe(false);
    expect(isLongTask('a\n'.repeat(8))).toBe(true);
    expect(isLongTask('a\nb\nc')).toBe(false);
    expect(isLongTask('x'.repeat(601))).toBe(true);
    expect(isLongTask('x'.repeat(600))).toBe(false);
  });
});
