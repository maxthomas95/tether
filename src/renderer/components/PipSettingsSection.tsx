import { useId, useState } from 'react';
import { CLI_TOOL_REGISTRY } from '../../shared/cli-tools';
import type { PipAiBackend, PipCommentResult, PipSettings } from '../../shared/pip';
import { usePipBackendStatus } from '../hooks/usePipBackendStatus';

export interface PipSettingsControl {
  settings: PipSettings | null;
  busy: boolean;
  update: (patch: Partial<PipSettings>) => Promise<void>;
}

const HOURLY_LIMITS = [2, 4, 6, 12, 20, 30];
const COOLDOWNS = [30, 60, 120, 300, 600, 900, 1800];

const BACKEND_HELP: Readonly<Record<PipAiBackend, string>> = {
  codex: 'Uses your local Codex ChatGPT sign-in and subscription allowance. Luna only.',
  claude: 'Uses your local Claude Code subscription sign-in and allowance. Haiku only.',
};

function cooldownLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  const rounded = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${rounded} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The preset list, plus the saved value when it is not one of the presets. */
function withSaved(presets: readonly number[], saved: number): number[] {
  return presets.includes(saved) ? [...presets] : [...presets, saved].sort((a, b) => a - b);
}

function tryQuipBlocker(settings: PipSettings): string | null {
  if (!settings.enabled) return 'Turn Pip on to try a quip.';
  if (settings.collapsed) return 'Expand Pip in the sidebar to try a quip.';
  if (settings.quiet) return 'Turn Quiet off to try a quip.';
  return null;
}

function quipOutcome(result: PipCommentResult): string {
  if (!result.line) return result.reason ?? 'No quip came back.';
  const model = result.model ? ` (${result.model})` : '';
  return `Pip: “${result.line}”${model}`;
}

/**
 * Settings → Pip. Every control saves as it changes, like the panel's own Quiet switch, because
 * Pip is live in the sidebar while this dialog is open.
 */
export function PipSettingsSection({ settings, busy, update }: Readonly<PipSettingsControl>) {
  const id = useId();
  const [trying, setTrying] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const aiOn = settings?.aiComments ?? false;
  const backend = usePipBackendStatus(settings?.aiBackend ?? 'codex', aiOn);

  if (!settings) return <p className="form-hint" role="status">Loading Pip preferences…</p>;

  const change = (patch: Partial<PipSettings>) => { void update(patch); };
  const recipient = CLI_TOOL_REGISTRY[settings.aiBackend].pipQuips?.recipient ?? 'the AI provider';
  const blocker = tryQuipBlocker(settings);
  const tryQuip = async () => {
    setTrying(true);
    setOutcome(null);
    try {
      setOutcome(quipOutcome(await window.electronAPI.pip.comment({ event: 'hello', sessionId: null })));
    } catch {
      setOutcome('Could not ask for a quip.');
    } finally {
      setTrying(false);
    }
  };

  return (
    <>
      <div className="form-group">
        <label className="form-radio-label">
          <input type="checkbox" checked={settings.enabled} disabled={busy}
            onChange={event => change({ enabled: event.target.checked })} />
          Show Pip in the sidebar
        </label>
        <p className="form-hint">
          A small cable gremlin that follows your focused session and reacts to its status. Same switch as
          {' '}<strong>View → Pip Sidebar Pet</strong>. Changes in this section save as you make them.
        </p>
      </div>

      <div className="form-group" style={{ marginTop: 20 }}>
        <div className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>Behavior</div>
        <label className="form-label" htmlFor={`${id}-personality`}>Personality</label>
        <select id={`${id}-personality`} className="form-input" value={settings.personality} disabled={busy}
          onChange={event => change({ personality: event.target.value === 'sweet' ? 'sweet' : 'dry' })}>
          <option value="dry">Dry little gremlin</option>
          <option value="sweet">Cozy companion</option>
        </select>

        <label className="form-radio-label" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={settings.quiet} disabled={busy}
            onChange={event => change({ quiet: event.target.checked })} />
          Quiet
        </label>
        <p className="form-hint">Keeps the expressions and silences every comment, local and AI.</p>

        <label className="form-radio-label" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={settings.motion} disabled={busy}
            onChange={event => change({ motion: event.target.checked })} />
          Ambient motion
        </label>
        <p className="form-hint">Idle animation and cursor tracking. Your system&rsquo;s reduced-motion preference also turns these off.</p>

        <label className="form-radio-label" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={settings.nudges} disabled={busy}
            onChange={event => change({ nudges: event.target.checked })} />
          Operational nudges
        </label>
        <p className="form-hint">
          One comment when Vault sign-in is about to expire, a quota passes 90%, a usage budget is crossed, or an
          update is available. Local only; never sent to an AI backend.
        </p>
      </div>

      <div className="form-group" style={{ marginTop: 20 }}>
        <div className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>AI quips</div>
        <label className="form-label" htmlFor={`${id}-backend`}>Backend</label>
        <select id={`${id}-backend`} className="form-input" value={aiOn ? settings.aiBackend : 'off'} disabled={busy}
          onChange={event => {
            const value = event.target.value;
            setOutcome(null);
            change(value === 'codex' || value === 'claude' ? { aiComments: true, aiBackend: value } : { aiComments: false });
          }}>
          <option value="off">Off (local quips only)</option>
          <option value="codex">Codex ({CLI_TOOL_REGISTRY.codex.pipQuips?.account})</option>
          <option value="claude">Claude ({CLI_TOOL_REGISTRY.claude.pipQuips?.account})</option>
        </select>
        <p className="form-hint">
          {aiOn ? BACKEND_HELP[settings.aiBackend] : 'Choose Codex or Claude for occasional generated comments. Off makes no model or network requests.'}
        </p>
        {aiOn && (
          <output className="form-hint pip-settings-status" data-ready={backend.status?.ready ?? undefined}>
            {backend.checking ? 'Checking sign-in…' : backend.status?.detail ?? ''}
          </output>
        )}

        <div className="pip-settings-limits">
          <div>
            <label className="form-label" htmlFor={`${id}-hourly`}>Quips per hour</label>
            <select id={`${id}-hourly`} className="form-input" value={settings.aiHourlyLimit} disabled={busy || !aiOn}
              onChange={event => change({ aiHourlyLimit: Number(event.target.value) })}>
              {withSaved(HOURLY_LIMITS, settings.aiHourlyLimit).map(limit => <option key={limit} value={limit}>Up to {limit}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor={`${id}-cooldown`}>Shortest gap between quips</label>
            <select id={`${id}-cooldown`} className="form-input" value={settings.aiCooldownSeconds} disabled={busy || !aiOn}
              onChange={event => change({ aiCooldownSeconds: Number(event.target.value) })}>
              {withSaved(COOLDOWNS, settings.aiCooldownSeconds).map(seconds => <option key={seconds} value={seconds}>{cooldownLabel(seconds)}</option>)}
            </select>
          </div>
        </div>
        <p className="form-hint">
          Each quip is one small request against your subscription allowance. The hourly limit counts every request,
          including failed ones and <strong>Try a quip</strong>; the gap applies to automatic quips. Both are enforced
          outside the window, so they survive reloads.
        </p>

        <label className="form-radio-label" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={settings.sharePrompts} disabled={busy || !aiOn}
            onChange={event => change({ sharePrompts: event.target.checked })} />
          Share submitted prompts
        </label>
        <p className="form-hint">
          Sends up to 400 characters from the latest local Claude, Codex or OpenCode prompt to {recipient} for specific
          jokes. Common secrets are scrubbed; private text can remain. Draft typing and terminal output stay local.
          Choosing another backend turns this off.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="form-btn" disabled={busy || trying || !aiOn || blocker !== null}
            onClick={() => { void tryQuip(); }}>
            {trying ? 'Asking…' : 'Try a quip'}
          </button>
          <output className="form-hint" style={{ margin: 0 }}>{outcome ?? (aiOn ? blocker : null) ?? ''}</output>
        </div>
        <p className="form-hint">Asks for one quip now and shows it here. It counts toward the hourly limit.</p>
      </div>
    </>
  );
}
