import { app } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { IPC } from '../../shared/constants';
import { PIP_AI_EVENTS, PIP_SETTINGS_KEY, readPipSettings, type PipCommentRequest } from '../../shared/pip';
import { createTrustedIpc } from './trusted-ipc';
import type { HandlerContext } from './helpers';
import { getDb } from '../db/database';
import { generatePipComment } from '../codex/pip-comment-client';
import { PipCommentService, setPipCommentService } from '../pip/comment-service';
import { readRecentPrompt } from '../pip/prompt-context';
import { sessionManager } from '../session/session-manager';
import { getEnvironment } from '../db/environment-repo';
import { usageService } from '../usage/usage-service';

export function validatePipRequest(raw: unknown): PipCommentRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Pip event.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'event' && key !== 'sessionId')
    || !PIP_AI_EVENTS.includes(value.event as never)
    || (value.sessionId !== null && (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200))) {
    throw new Error('Invalid Pip event.');
  }
  return { event: value.event as PipCommentRequest['event'], sessionId: value.sessionId as string | null };
}

export function registerPipHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  const service = new PipCommentService({
    settings: () => readPipSettings(getDb().config[PIP_SETTINGS_KEY] ?? null),
    async generate(request, settings, signal) {
      const cwd = path.join(app.getPath('userData'), 'pip-workspace');
      await mkdir(cwd, { recursive: true });
      let prompt: string | null = null;
      if (settings.sharePrompts && request.sessionId && request.event !== 'attention') {
        const session = sessionManager.getSession(request.sessionId);
        const env = session?.environmentId ? getEnvironment(session.environmentId) : null;
        if (session && (!session.environmentId || env?.type === 'local') && ['claude', 'codex'].includes(session.cliTool ?? 'claude')) {
          const id = session.usageSessionId ?? session.toolSessionId ?? session.claudeSessionId;
          const file = id ? usageService.getLocalTranscriptPath(id) : null;
          if (file) prompt = await readRecentPrompt(file).catch(() => null);
        }
      }
      return generatePipComment({ cwd, event: request.event, personality: settings.personality, prompt, signal });
    },
  });
  setPipCommentService(service);
  ctx.mainWindow.on('closed', () => service.cancel());
  ctx.mainWindow.on('hide', () => service.cancel());
  ctx.mainWindow.on('minimize', () => service.cancel());
  ctx.mainWindow.webContents.on('render-process-gone', () => service.cancel());
  ipc.handle(IPC.PIP_COMMENT, (_event, raw: unknown) => {
    const request = validatePipRequest(raw);
    if (!ctx.mainWindow.isVisible() || ctx.mainWindow.isMinimized()) {
      return { status: 'paused', line: null, model: null, reason: 'AI comments paused while Tether is hidden.' };
    }
    return service.comment(request);
  });
  ipc.handle(IPC.PIP_CANCEL_COMMENT, () => service.cancel());
}
