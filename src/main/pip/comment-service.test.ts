import { describe, it, expect, vi } from 'vitest';
import { PipCommentService } from './comment-service';
import { DEFAULT_PIP_SETTINGS, PIP_AI_COOLDOWN_MS, type PipCommentResult } from '../../shared/pip';

const reply: PipCommentResult = { status: 'ready', line: 'The keyboard has opinions.', model: 'gpt-6-luna', reason: null };
const request = { event: 'submitted' as const, sessionId: 'a' };
function fixture() {
  let now = 1_000_000;
  let settings = { ...DEFAULT_PIP_SETTINGS, enabled: true, aiComments: true };
  const generate = vi.fn().mockResolvedValue(reply);
  const service = new PipCommentService({ settings: () => settings, generate, now: () => now });
  return { service, generate, time: (value: number) => { now += value; }, settings: (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch }; } };
}
describe('Pip subscription limits', () => {
  it.each(['aiComments', 'enabled', 'quiet', 'collapsed'] as const)('checks persisted %s before generating', async key => {
    const f = fixture();
    f.settings({ [key]: key === 'quiet' || key === 'collapsed' });
    expect((await f.service.comment(request)).status).toBe('paused');
    expect(f.generate).not.toHaveBeenCalled();
  });
  it('counts failed attempts, enforces cooldown and hourly cap, then recovers', async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new Error('private provider error'));
    expect((await f.service.comment(request)).reason).not.toContain('private');
    expect((await f.service.comment(request)).status).toBe('paused');
    for (let i = 1; i < 12; i++) { f.time(PIP_AI_COOLDOWN_MS); await f.service.comment(request); }
    f.time(PIP_AI_COOLDOWN_MS);
    expect((await f.service.comment(request)).reason).toContain('Hourly');
    expect(f.generate).toHaveBeenCalledTimes(12);
    f.time(3_600_000);
    await f.service.comment(request);
    expect(f.generate).toHaveBeenCalledTimes(13);
  });
  it('allows only one pending request and discards a reply after cancellation', async () => {
    const f = fixture();
    let resolve!: (value: PipCommentResult) => void;
    f.generate.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = f.service.comment(request);
    expect((await f.service.comment(request)).status).toBe('paused');
    f.service.cancel();
    expect(f.generate.mock.calls[0][2].aborted).toBe(true);
    resolve(reply);
    expect((await pending).line).toBeNull();
  });
  it('does not show a reply after prompt consent is revoked', async () => {
    const f = fixture();
    f.settings({ sharePrompts: true });
    f.generate.mockImplementation(async () => { f.settings({ sharePrompts: false }); return reply; });
    expect((await f.service.comment(request)).line).toBeNull();
  });
});
