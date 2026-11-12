import { callCodexAppServer } from '../../codex/app-server-client';
import { generatePipComment, selectPipModel } from '../../codex/pip-comment-client';
import type { PipBackendStatus } from '../../../shared/pip';
import type { PipCommentBackend } from './types';

const MODEL_NAMES: Readonly<Record<string, string>> = { 'gpt-6-luna': 'GPT-6 Luna', 'gpt-5.6-luna': 'GPT-5.6 Luna' };

/** Same account and model rules the quip itself applies, without starting a thread. */
export async function codexPipStatus(signal: AbortSignal, call = callCodexAppServer): Promise<PipBackendStatus> {
  const unavailable = (detail: string): PipBackendStatus => ({ backend: 'codex', ready: false, detail });
  const results = await call([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'model/list', params: { limit: 100, includeHidden: false } },
  ], { signal }).catch(() => null);
  const [account, models] = results ?? [];
  if (!account?.ok || !models?.ok) {
    return unavailable('Could not reach the Codex CLI. Check that it is installed and on PATH.');
  }
  const type = (account.result as { account?: { type?: unknown } } | undefined)?.account?.type;
  if (type !== 'chatgpt') return unavailable('Sign in to Codex with ChatGPT to enable AI quips.');
  const model = selectPipModel(models.result);
  if (!model) return unavailable('No Luna model available in this Codex CLI. Using local quips.');
  return { backend: 'codex', ready: true, detail: `Signed in with ChatGPT. Quips use ${MODEL_NAMES[model.model] ?? model.model}.` };
}

export const codexPipBackend: PipCommentBackend = {
  id: 'codex',
  generate: (request, signal) => generatePipComment({ ...request, signal }),
  status: (_cwd, signal) => codexPipStatus(signal),
};
