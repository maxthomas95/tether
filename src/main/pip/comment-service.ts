import { PIP_AI_COOLDOWN_MS, PIP_AI_HOURLY_LIMIT, type PipCommentRequest, type PipCommentResult, type PipSettings } from '../../shared/pip';

const paused = (reason: string): PipCommentResult => ({ status: 'paused', line: null, model: null, reason });
export interface PipCommentDependencies {
  settings(): PipSettings;
  generate(request: PipCommentRequest, settings: PipSettings, signal: AbortSignal): Promise<PipCommentResult>;
  now?: () => number;
}

/** Main-process limits survive renderer remounts and cannot be bypassed by UI requests. */
export class PipCommentService {
  private attempts: number[] = [];
  private pending: AbortController | null = null;
  constructor(private readonly dependencies: PipCommentDependencies) {}

  cancel(): void { this.pending?.abort(); }

  async comment(request: PipCommentRequest): Promise<PipCommentResult> {
    const settings = this.dependencies.settings();
    if (!settings.enabled || settings.collapsed || settings.quiet || !settings.aiComments) return paused('AI comments off.');
    if (this.pending) return paused('Pip is already thinking of a quip.');
    const now = this.dependencies.now?.() ?? Date.now();
    this.attempts = this.attempts.filter(time => now - time < 3_600_000);
    if (this.attempts.length >= PIP_AI_HOURLY_LIMIT) return paused('Hourly limit reached. Local quips for now.');
    if (this.attempts.length && now - this.attempts[this.attempts.length - 1] < PIP_AI_COOLDOWN_MS) return paused('Taking a breather between AI comments.');
    this.attempts.push(now);
    const controller = new AbortController();
    this.pending = controller;
    try {
      const result = await this.dependencies.generate(request, settings, controller.signal);
      const current = this.dependencies.settings();
      if (controller.signal.aborted || !current.enabled || current.collapsed || current.quiet || !current.aiComments
        || current.personality !== settings.personality || current.sharePrompts !== settings.sharePrompts) return paused('AI comment cancelled.');
      return result;
    } catch {
      return { status: 'unavailable', line: null, model: null, reason: 'AI comments unavailable. Using local quips.' };
    } finally {
      this.pending = null;
    }
  }
}

let activeService: PipCommentService | null = null;
export function setPipCommentService(service: PipCommentService): void { activeService?.cancel(); activeService = service; }
export function cancelPipComments(): void { activeService?.cancel(); }
