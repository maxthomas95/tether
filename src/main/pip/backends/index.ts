import type { PipAiBackend } from '../../../shared/pip';
import { claudePipBackend } from './claude';
import { codexPipBackend } from './codex';
import type { PipCommentBackend } from './types';

export type { PipBackendRequest, PipCommentBackend } from './types';

const BACKENDS: Readonly<Record<PipAiBackend, PipCommentBackend>> = { codex: codexPipBackend, claude: claudePipBackend };

export function pipBackend(id: PipAiBackend): PipCommentBackend {
  return BACKENDS[id];
}
