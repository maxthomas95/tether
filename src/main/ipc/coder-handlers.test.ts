import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const coderMocks = vi.hoisted(() => ({
  listCoderWorkspaces: vi.fn(),
  listCoderTemplates: vi.fn(),
  getCoderTemplateParams: vi.fn(),
  createCoderWorkspace: vi.fn(),
}));
vi.mock('../coder/workspace-service', () => coderMocks);

import { IPC } from '../../shared/constants';
import { registerCoderHandlers } from './coder-handlers';

const harness = createHarness(registry);

describe('coder-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(coderMocks).forEach((m) => m.mockReset());
    registerCoderHandlers(harness.ctx);
  });

  it('CODER_LIST_WORKSPACES forwards environmentId', async () => {
    coderMocks.listCoderWorkspaces.mockResolvedValue([{ id: 'w1' }]);
    const result = await harness.invoke(IPC.CODER_LIST_WORKSPACES, 'env-1');
    expect(coderMocks.listCoderWorkspaces).toHaveBeenCalledWith('env-1');
    expect(result).toEqual([{ id: 'w1' }]);
  });

  it('CODER_LIST_TEMPLATES forwards environmentId', async () => {
    coderMocks.listCoderTemplates.mockResolvedValue([]);
    await harness.invoke(IPC.CODER_LIST_TEMPLATES, 'env-1');
    expect(coderMocks.listCoderTemplates).toHaveBeenCalledWith('env-1');
  });

  it('CODER_GET_TEMPLATE_PARAMS forwards environmentId + templateVersionId', async () => {
    coderMocks.getCoderTemplateParams.mockResolvedValue([]);
    await harness.invoke(IPC.CODER_GET_TEMPLATE_PARAMS, 'env-1', 'tv-2');
    expect(coderMocks.getCoderTemplateParams).toHaveBeenCalledWith('env-1', 'tv-2');
  });

  it('CODER_CREATE_WORKSPACE pipes the progress callback to renderer via IPC.CODER_CREATE_PROGRESS', async () => {
    let captured: ((line: string) => void) | null = null;
    coderMocks.createCoderWorkspace.mockImplementation(async (_opts: unknown, onProgress: (line: string) => void) => {
      captured = onProgress;
      return { id: 'new' };
    });

    const opts = { environmentId: 'env-1', templateId: 't', name: 'ws' };
    const result = await harness.invoke(IPC.CODER_CREATE_WORKSPACE, opts);
    expect(coderMocks.createCoderWorkspace).toHaveBeenCalledWith(opts, expect.any(Function));
    expect(result).toEqual({ id: 'new' });

    captured!('progress line');
    expect(harness.send).toHaveBeenCalledWith(IPC.CODER_CREATE_PROGRESS, 'progress line');
  });
});
