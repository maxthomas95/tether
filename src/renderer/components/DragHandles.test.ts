// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitDivider } from './SplitDivider';
import { PaneLocationBadge } from './sidebar/PaneLocationBadge';
import { SidebarResizeHandle } from './sidebar/SidebarResizeHandle';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../utils/sidebar-width';
import { click, createView } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => view.dispose());

async function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  await act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });
}

describe('SidebarResizeHandle', () => {
  const handle = () => view.container.querySelector<HTMLElement>('.sidebar-resize-handle')!;

  it('resizes while dragging, within the sidebar bounds, and reports the final width once', async () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    await view.render(React.createElement(SidebarResizeHandle, { onResize, onResizeEnd }));

    await mouse(handle(), 'mousedown');
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    await mouse(document, 'mousemove', { clientX: 300 });
    await mouse(document, 'mousemove', { clientX: 5 });
    await mouse(document, 'mousemove', { clientX: 5000 });
    expect(onResize.mock.calls.map(call => call[0])).toEqual([300, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]);

    await mouse(document, 'mouseup');
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(SIDEBAR_MAX_WIDTH);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    await mouse(document, 'mousemove', { clientX: 250 });
    expect(onResize).toHaveBeenCalledTimes(3);
  });

  it('does not report a width for a click that never moved', async () => {
    const onResizeEnd = vi.fn();
    await view.render(React.createElement(SidebarResizeHandle, { onResize: vi.fn(), onResizeEnd }));

    await mouse(handle(), 'mousedown');
    await mouse(document, 'mouseup');

    expect(onResizeEnd).not.toHaveBeenCalled();
  });
});

describe('SplitDivider', () => {
  const divider = () => view.container.querySelector<HTMLElement>('.split-divider')!;
  function parent(): React.RefObject<HTMLDivElement | null> {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ left: 100, top: 50, width: 1000, height: 400 }) as DOMRect;
    return { current: element };
  }

  it('reports the horizontal ratio under the pointer, clamped so neither pane collapses', async () => {
    const onRatioChange = vi.fn();
    await view.render(React.createElement(SplitDivider, { direction: 'horizontal', splitId: 's1', onRatioChange, parentRef: parent() }));

    await mouse(divider(), 'mousedown');
    expect(divider().className).toContain('split-divider--active');
    await mouse(document, 'mousemove', { clientX: 400 });
    await mouse(document, 'mousemove', { clientX: 0 });
    await mouse(document, 'mousemove', { clientX: 5000 });
    expect(onRatioChange.mock.calls).toEqual([['s1', 0.3], ['s1', 0.15], ['s1', 0.85]]);

    await mouse(document, 'mouseup');
    expect(divider().className).not.toContain('split-divider--active');
    await mouse(document, 'mousemove', { clientX: 600 });
    expect(onRatioChange).toHaveBeenCalledTimes(3);
  });

  it('measures vertical splits from the top edge and resets to half on double-click', async () => {
    const onRatioChange = vi.fn();
    await view.render(React.createElement(SplitDivider, { direction: 'vertical', splitId: 's2', onRatioChange, parentRef: parent() }));

    await mouse(divider(), 'mousedown');
    await mouse(document, 'mousemove', { clientY: 250 });
    await mouse(document, 'mouseup');
    await mouse(divider(), 'dblclick');

    expect(onRatioChange.mock.calls).toEqual([['s2', 0.5], ['s2', 0.5]]);
    expect(divider().className).toContain('split-divider--vertical');
  });

  it('ignores a drag when the split container is gone', async () => {
    const onRatioChange = vi.fn();
    await view.render(React.createElement(SplitDivider, { direction: 'horizontal', splitId: 's1', onRatioChange, parentRef: { current: null } }));

    await mouse(divider(), 'mousedown');
    await mouse(document, 'mousemove', { clientX: 400 });
    await mouse(document, 'mouseup');

    expect(onRatioChange).not.toHaveBeenCalled();
  });
});

describe('PaneLocationBadge', () => {
  const badge = () => view.container.querySelector<HTMLButtonElement>('button')!;
  async function render(shape: 'single' | 'split-h' | 'split-v' | 'grid', slotIndex: number, hidden = false) {
    const onClick = vi.fn();
    const totalSlots = { single: 1, 'split-h': 2, 'split-v': 2, grid: 4 }[shape];
    await view.render(React.createElement(PaneLocationBadge, { location: { paneId: 'p', shape, slotIndex, totalSlots }, hidden, onClick }));
    return onClick;
  }

  it.each([
    ['single', 0, 1, 'sole pane'],
    ['split-h', 0, 2, 'left pane'],
    ['split-h', 1, 2, 'right pane'],
    ['split-v', 0, 2, 'top pane'],
    ['split-v', 1, 2, 'bottom pane'],
    ['grid', 2, 4, 'bottom-left'],
    ['grid', 9, 4, 'pane'],
  ] as const)('draws %s slot %i as %i cells and calls it the %s', async (shape, slotIndex, cells, name) => {
    await render(shape, slotIndex);

    expect(badge().getAttribute('aria-label')).toBe(`In ${name}. Click to focus.`);
    expect(view.container.querySelectorAll('rect')).toHaveLength(cells);
    const active = [...view.container.querySelectorAll('rect')].findIndex(rect => rect.classList.contains('pane-location-cell--active'));
    expect(active).toBe(slotIndex < cells ? slotIndex : -1);
  });

  it('explains a pane hidden behind a maximized one', async () => {
    await render('grid', 1, true);
    expect(badge().title).toContain('top-right — hidden behind another maximized pane');
    expect(badge().className).toContain('pane-location-badge--hidden');
  });

  it('focuses the pane by mouse or keyboard without selecting the session row beneath it', async () => {
    const onClick = await render('split-h', 1);
    const rowClick = vi.fn();
    const rowKeyDown = vi.fn();
    // React delegates from the root container, so observe from above it.
    document.body.addEventListener('click', rowClick);
    document.body.addEventListener('keydown', rowKeyDown);

    await click(badge());
    for (const key of ['Enter', ' ', 'Tab']) {
      await act(async () => { badge().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    }

    expect(onClick).toHaveBeenCalledTimes(3);
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKeyDown).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('click', rowClick);
    document.body.removeEventListener('keydown', rowKeyDown);
  });
});
