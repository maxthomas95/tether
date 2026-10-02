// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { EnvironmentInfo } from '../../shared/types';
import { WelcomePane } from './WelcomePane';

it('keeps home actions accessible alongside the pausable, decorative logo', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const project = { environmentId: 'local', workingDir: '/repo/tether' };
  const props = {
    environments: [{ id: 'local', type: 'local', name: 'Local' }] as EnvironmentInfo[],
    enableResumePicker: true,
    recentProjects: [project],
    onOpenProject: vi.fn(), onNewLocalSession: vi.fn(), onConnectSsh: vi.fn(),
    onOpenCoder: vi.fn(), onResume: vi.fn(),
  };
  try {
    await act(async () => root.render(createElement(WelcomePane, props)));
    expect(container.querySelector('h1')?.textContent).toBe('Pick up where you left off');
    expect(container.querySelector('.ascii-tether__viewport')?.getAttribute('aria-hidden')).toBe('true');
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Pause logo animation"]')!;
    toggle.focus();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-label')).toBe('Play logo animation');
    expect(document.activeElement).toBe(toggle);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-label')).toBe('Pause logo animation');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.recent-project')!.click();
      container.querySelectorAll<HTMLButtonElement>('.welcome-card').forEach(button => button.click());
      container.querySelector<HTMLButtonElement>('.welcome-pane__resume-link')!.click();
    });
    expect(props.onOpenProject).toHaveBeenCalledWith(project);
    [props.onNewLocalSession, props.onConnectSsh, props.onOpenCoder, props.onResume]
      .forEach(callback => expect(callback).toHaveBeenCalledOnce());

    await act(async () => root.render(createElement(WelcomePane, { ...props, recentProjects: [] })));
    expect(container.querySelector('h1')?.textContent).toBe('Welcome to Tether');
    expect(container.querySelector('.ascii-tether')).toBeNull();
    expect(container.querySelector('.welcome-diagram')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
