// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildAgentRows } from './ChildAgentRows';
import { createView } from '../visibility.test-helper';
import type { ChildAgentInfo, ChildAgentList } from '../../../shared/child-agents';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function agent(over: Partial<ChildAgentInfo> = {}): ChildAgentInfo {
  return {
    source: 'claude-subagent', id: 'a1', agentType: 'tester', description: 'Check things', background: true, depth: 1,
    model: 'claude-sonnet-5-5', effort: 'medium', state: 'done', startedAt: iso(0), lastActivityAt: iso(41),
    tokens: { input: 5, output: 1200, cacheRead: 0, cacheWrite: 300 }, ...over,
  };
}

let view: ReturnType<typeof createView>;
let toggle: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;

async function render(list: ChildAgentList, expanded = true) {
  await view.render(React.createElement(ChildAgentRows, { sessionLabel: 'my session', list, expanded, onToggle: toggle, onOpen: open }));
}
const rows = () => [...view.container.querySelectorAll<HTMLElement>('.child-agent-row')];
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0 + 125_000);
  view = createView();
  toggle = vi.fn();
  open = vi.fn();
});
afterEach(async () => { await view.dispose(); vi.useRealTimers(); });

describe('ChildAgentRows', () => {
  it('renders nothing for a session that has had no subagents', async () => {
    await render({ agents: [], total: 0 });
    expect(view.container.querySelector('.child-agents')).toBeNull();
  });

  it('shows a collapsed summary with the running count and no rows until expanded', async () => {
    await render({ agents: [agent(), agent({ id: 'a2', state: 'running' })], total: 2 }, false);
    const header = view.container.querySelector<HTMLElement>('.child-agents-toggle')!;
    expect(header.textContent).toContain('2 subagents');
    expect(header.textContent).toContain('1 running');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toHaveLength(0);
  });

  it('toggles from the mouse and from Enter or Space', async () => {
    await render({ agents: [agent()], total: 1 }, false);
    const header = view.container.querySelector<HTMLElement>('.child-agents-toggle')!;
    expect(header.textContent).toContain('1 subagent');
    expect(header.textContent).not.toContain('1 subagents');
    await act(async () => header.click());
    await key(header, 'Enter');
    await key(header, ' ');
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it('shows each agent with type, description, model/effort, timing and tokens, and a dot matching its state', async () => {
    await render({ agents: [agent(), agent({ id: 'a2', state: 'running', startedAt: iso(0), lastActivityAt: iso(100) })], total: 2 });
    const [done, running] = rows();
    expect(done.querySelector('.child-agent-title')?.textContent).toBe('↳ tester · Check things');
    expect(done.querySelector('.child-agent-meta')?.textContent).toBe('sonnet-5-5/medium · done 41s · 1.5k tok');
    expect(done.querySelector('.status-dot')?.className).toContain('status-dot--idle');
    expect(running.querySelector('.child-agent-meta')?.textContent).toContain('running 2m');
    expect(running.querySelector('.status-dot')?.className).toContain('status-dot--running');
    expect(done.getAttribute('aria-label')).toContain('tester');
    expect(done.getAttribute('role')).toBe('button');
    expect(done.tabIndex).toBe(0);
  });

  it('counts a running agent up once a second', async () => {
    await render({ agents: [agent({ state: 'running' })], total: 1 });
    expect(rows()[0].querySelector('.child-agent-meta')?.textContent).toContain('running 2m');
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(rows()[0].querySelector('.child-agent-meta')?.textContent).toContain('running 3m');
  });

  it('indents deeper children', async () => {
    await render({ agents: [agent(), agent({ id: 'a2', depth: 3 })], total: 2 });
    const [shallow, deep] = rows();
    expect(shallow.style.paddingLeft).toContain('+ 0px');
    expect(deep.style.paddingLeft).toContain('+ 24px');
  });

  it('opens a transcript from a click or Enter', async () => {
    const first = agent();
    await render({ agents: [first], total: 1 });
    await act(async () => rows()[0].click());
    await key(rows()[0], 'Enter');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(first);
  });

  it('caps the list at 20 with a "+N more" control that reveals the rest', async () => {
    const agents = Array.from({ length: 24 }, (_, i) => agent({ id: `n${i}` }));
    await render({ agents, total: 24 });
    expect(rows()).toHaveLength(20);
    const more = view.container.querySelector<HTMLElement>('.child-agents-more')!;
    expect(more.textContent).toBe('+4 more');
    await key(more, 'Enter');
    expect(rows()).toHaveLength(24);
    expect(view.container.querySelector('.child-agents-more')).toBeNull();
  });

  it('says so when older subagents were left out of the list entirely', async () => {
    await render({ agents: [agent()], total: 60 });
    expect(view.container.querySelector('.child-agents-note')?.textContent).toBe('59 older not shown');
  });
});
