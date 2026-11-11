// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewSessionDialog } from './NewSessionDialog';

vi.mock('../EnvVarEditor', () => ({ EnvVarEditor: () => null }));
vi.mock('../HelpAnchor', () => ({ HelpAnchor: () => null }));
vi.mock('./ResumeChatDialog', () => ({ ResumeChatDialog: () => null }));

// React tracks a controlled input through the native value setter, so
// assigning `input.value` directly would never reach the component's state.
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function tick(input: HTMLInputElement): void {
  input.click();
}

const REPOS_ROOT = String.raw`C:\repos`;

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof makeApi>;

function makeApi() {
  return {
    config: {
      get: vi.fn(async (key: string) => (key === 'reposRoot' ? REPOS_ROOT : null)),
      set: vi.fn().mockResolvedValue(undefined),
      getDefaultEnvVars: vi.fn().mockResolvedValue({}),
      getDefaultCliFlagsPerTool: vi.fn().mockResolvedValue({}),
    },
    scanReposDir: vi.fn().mockResolvedValue([]),
    gitProvider: { list: vi.fn().mockResolvedValue([]) },
    vault: { status: vi.fn().mockResolvedValue({ loggedIn: false }) },
    git: {
      isRepo: vi.fn().mockResolvedValue(false),
      onCloneProgress: vi.fn(() => () => {}),
      worktreeAdd: vi.fn(async ({ worktreePath }: { worktreePath: string }) => worktreePath),
      worktreeRemove: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn(async (path: string) => path),
      clone: vi.fn(async (_url: string, dest: string) => dest),
    },
    dialog: { openDirectory: vi.fn().mockResolvedValue(null) },
  };
}

async function render(onCreate: (...args: unknown[]) => Promise<boolean>, onClose = vi.fn()) {
  await act(async () => root.render(createElement(NewSessionDialog, {
    isOpen: true, environments: [], profiles: [], onClose, onCreate,
  })));
  return onClose;
}

const primary = () => container.querySelector<HTMLButtonElement>('.dialog-footer .form-btn--primary')!;
const byId = (suffix: string) => container.querySelector<HTMLInputElement>(`input[id$="${suffix}"]`)!;

async function click(el: HTMLElement) {
  await act(async () => { el.click(); });
}

async function openTab(name: string) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('.source-tab'))
    .find(b => b.textContent === name)!;
  await click(tab);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api = makeApi();
  vi.stubGlobal('electronAPI', api);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('closes only after the session is created and ignores a second submit while pending', async () => {
  let resolveCreate!: (ok: boolean) => void;
  const onCreate = vi.fn(() => new Promise<boolean>(resolve => { resolveCreate = resolve; }));
  const onClose = await render(onCreate);

  await act(async () => typeInto(container.querySelector<HTMLInputElement>('#new-session-directory')!, String.raw`C:\repos\app`));
  await click(primary());
  expect(primary().disabled).toBe(true);
  await click(primary());
  expect(onCreate).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => resolveCreate(true));
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps the dialog open and re-enables submit when session creation fails', async () => {
  const onCreate = vi.fn().mockResolvedValue(false);
  const onClose = await render(onCreate);

  const directory = container.querySelector<HTMLInputElement>('#new-session-directory')!;
  await act(async () => typeInto(directory, String.raw`C:\repos\app`));
  await click(primary());

  expect(onCreate).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(directory.value).toBe(String.raw`C:\repos\app`);
  expect(primary().disabled).toBe(false);
});

async function prepareWorktree(onCreate: (...args: unknown[]) => Promise<boolean>) {
  api.git.isRepo.mockResolvedValue(true);
  const onClose = await render(onCreate);
  await act(async () => typeInto(container.querySelector<HTMLInputElement>('#new-session-directory')!, String.raw`C:\repos\app`));
  const toggle = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .find(box => box.parentElement?.textContent?.includes('Create as new git worktree'))!;
  await act(async () => tick(toggle));
  await act(async () => typeInto(byId('-branch'), 'feat/x'));
  return onClose;
}

it('removes the new worktree when the session it was made for fails to start', async () => {
  const onCreate = vi.fn().mockResolvedValue(false);
  const onClose = await prepareWorktree(onCreate);
  const worktreePath = byId('-worktree-path').value;
  expect(worktreePath).toBe(String.raw`C:\repos\app-feat-x`);

  await click(primary());

  expect(api.git.worktreeAdd).toHaveBeenCalledOnce();
  expect(onCreate.mock.calls[0][0]).toBe(worktreePath);
  expect(onCreate.mock.calls[0][11]).toBe(String.raw`C:\repos\app`);
  expect(api.git.worktreeRemove).toHaveBeenCalledWith({ sourceRepo: String.raw`C:\repos\app`, worktreePath, force: true });
  expect(onClose).not.toHaveBeenCalled();
  expect(primary().disabled).toBe(false);
});

it('reports a worktree it could not clean up after a failed start', async () => {
  api.git.worktreeRemove.mockRejectedValue(new Error('locked'));
  const onCreate = vi.fn().mockResolvedValue(false);
  await prepareWorktree(onCreate);

  await click(primary());

  expect(container.textContent).toContain(String.raw`the worktree was left at C:\repos\app-feat-x: locked`);
});

it('keeps the worktree and closes when the session starts', async () => {
  const onCreate = vi.fn().mockResolvedValue(true);
  const onClose = await prepareWorktree(onCreate);

  await click(primary());

  expect(api.git.worktreeRemove).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps the new-folder form open until its session starts', async () => {
  const onCreate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const onClose = await render(onCreate);
  await openTab('New folder');
  await act(async () => typeInto(byId('-folder'), 'fresh'));

  await click(primary());
  expect(api.git.createFolder).toHaveBeenCalledWith(String.raw`C:\repos\fresh`, expect.any(Boolean));
  expect(onCreate.mock.calls[0][0]).toBe(String.raw`C:\repos\fresh`);
  expect(onClose).not.toHaveBeenCalled();
  expect(primary().disabled).toBe(false);

  await click(primary());
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps the clone form open until its session starts', async () => {
  const onCreate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const onClose = await render(onCreate);
  await openTab('Clone URL');
  await act(async () => typeInto(byId('-git-url'), 'https://example.invalid/team/repo.git'));

  await click(primary());
  expect(api.git.clone).toHaveBeenCalledWith('https://example.invalid/team/repo.git', String.raw`C:\repos\repo`);
  expect(onCreate.mock.calls[0][0]).toBe(String.raw`C:\repos\repo`);
  expect(onClose).not.toHaveBeenCalled();
  expect(primary().disabled).toBe(false);

  await click(primary());
  expect(onClose).toHaveBeenCalledOnce();
});
