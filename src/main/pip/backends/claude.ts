import { generatePipClaudeComment, pipClaudeStatus } from '../../claude/pip-comment-client';
import type { PipCommentBackend } from './types';

export const claudePipBackend: PipCommentBackend = {
  id: 'claude',
  generate: (request, signal) => generatePipClaudeComment({ ...request, signal }),
  status: cwd => pipClaudeStatus(cwd),
};
