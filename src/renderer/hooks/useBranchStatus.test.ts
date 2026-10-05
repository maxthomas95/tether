// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useBranchStatus } from './useBranchStatus';

it('clears unavailable status and recovers on the next focus refresh', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const branchStatus = vi.fn().mockRejectedValueOnce(new Error('git unavailable'))
    .mockResolvedValueOnce({ branch: 'main', dirtyCount: 2 });
  vi.stubGlobal('electronAPI', { git: { branchStatus } });
  let status: ReturnType<typeof useBranchStatus>;
  function Harness() { status = useBranchStatus('/repo', true); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(status!).toBeNull();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(status!).toEqual({ branch: 'main', dirtyCount: 2 });
    branchStatus.mockRejectedValueOnce(new Error('git unavailable'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(status!).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('unsubscribes and ignores a pending Git failure after the group is removed', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let reject!: (error: Error) => void;
  const branchStatus = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  vi.stubGlobal('electronAPI', { git: { branchStatus } });
  function Harness() { useBranchStatus('/repo', true); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => root.unmount());
    await act(async () => reject(new Error('late Git failure')));
    window.dispatchEvent(new Event('focus'));
    expect(branchStatus).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
