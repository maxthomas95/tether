import { useCallback, useId, useState } from 'react';
import { Icon } from '../Icon';
import { usePip } from '../../hooks/usePip';
import { PIP_MOOD_LABELS, pipSessionLabel, type PipSession } from '../../lib/pip-behavior';
import type { PipSettings } from '../../lib/pip-settings';
import type { PipNudge } from '../../lib/pip-nudges';
import { PipNudgeFeed } from './PipNudgeFeed';
import { usePipBackendStatus } from '../../hooks/usePipBackendStatus';
import { CLI_TOOL_REGISTRY } from '../../../shared/cli-tools';
import type { PipAiBackend } from '../../../shared/pip';
import './pip-panel.css';

interface PipPanelProps {
  settings: PipSettings;
  sessions: readonly PipSession[];
  activeSessionId: string | null;
  /** Running child agents per session id; omitted when subagent rows are off. */
  childCounts?: ReadonlyMap<string, number>;
  /** Version of an available Tether update, for the optional operational nudges. */
  updateVersion?: string | null;
  busy: boolean;
  onSettingsChange: (patch: Partial<PipSettings>) => Promise<void>;
  onActivateSession: (sessionId: string) => void;
}

function PipArtwork() {
  return <span className="pip-creature" aria-hidden="true">
    <svg className="pip-cable" viewBox="0 0 180 160" fill="none">
      <path className="pip-tail" d="M104 133 C149 147 174 111 153 94 C133 78 116 106 132 119 C144 129 162 115 165 95" />
      <g className="pip-plug"><path d="M160 88 L170 90 L169 101 L159 99 Z" /><path d="M163 89 L164 82 M168 90 L169 83" /></g>
    </svg>
    <span className="pip-body"><svg className="pip-link" viewBox="0 0 32 32" fill="none"><path d="M18 9 21 6a5 5 0 0 1 7 7l-6 6a5 5 0 0 1-7 0M14 23l-3 3a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 0M11 21l10-10" /></svg></span>
    <span className="pip-paw pip-paw-left" /><span className="pip-paw pip-paw-right" />
    <span className="pip-head"><span className="pip-ear pip-ear-left" /><span className="pip-ear pip-ear-right" />
      <span className="pip-face"><span className="pip-eye pip-eye-left"><span className="pip-pupil" /></span><span className="pip-eye pip-eye-right"><span className="pip-pupil" /></span><span className="pip-mouth" /><span className="pip-cursor" /></span>
      <span className="pip-status-light" />
    </span>
    <span className="pip-keyboard"><i /><i /><i /><i /><i /></span>
  </span>;
}

const NO_NUDGES: readonly PipNudge[] = [];

const BACKEND_HELP: Readonly<Record<PipAiBackend, string>> = {
  codex: 'Uses your local Codex ChatGPT sign-in and subscription allowance. Luna only; up to 12 quips/hour.',
  claude: 'Uses your local Claude Code subscription sign-in and allowance. Haiku only; up to 12 quips/hour.',
};

function pipActivityStatus(quiet: boolean, comments: ReturnType<typeof usePip>['comments']): string {
  if (quiet) return 'AI paused while Quiet is on.';
  if (comments.pending) return 'Thinking of a quip…';
  if (comments.result?.reason) return comments.result.reason;
  return comments.result?.model ? `Quip via ${comments.result.model}` : 'AI on. Waiting for a session moment.';
}

export function PipPanel({ settings, sessions, activeSessionId, childCounts, updateVersion = null, busy, onSettingsChange, onActivateSession }: Readonly<PipPanelProps>) {
  const [nudges, setNudges] = useState<readonly PipNudge[]>(NO_NUDGES);
  const receiveNudges = useCallback((next: readonly PipNudge[]) => setNudges(next), []);
  const pip = usePip(sessions, activeSessionId, settings, childCounts, nudges);
  const contentId = useId();
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const backend = usePipBackendStatus(settings.aiBackend, pip.active && optionsOpen && settings.aiComments);
  const recipient = CLI_TOOL_REGISTRY[settings.aiBackend].pipQuips?.recipient ?? 'the AI provider';
  const waiting = sessions.filter(session => session.id !== activeSessionId && session.state === 'waiting');
  const nextWaiting = waiting.find(session => session.waitingReason === 'permission') ?? waiting[0];
  const update = (patch: Partial<PipSettings>) => { void onSettingsChange(patch); };
  // Shown in the footer, or in the header while collapsed. It is plain markup, so a collapsed Pip still runs no timers.
  const waitingButton = nextWaiting ? <button type="button" className="pip-waiting" onClick={() => onActivateSession(nextWaiting.id)}
    title={`View ${pipSessionLabel(nextWaiting)}`} aria-label={`View ${pipSessionLabel(nextWaiting)}; ${waiting.length} other session${waiting.length === 1 ? '' : 's'} waiting`}>
    {waiting.length} waiting <Icon name="chevron" size={10} />
  </button> : null;

  return <section className="pip-panel" aria-label="Pip sidebar pet" ref={pip.panelRef}
    data-mood={pip.mood} data-motion={pip.motionAllowed} data-quiet={settings.quiet}>
    <div className="pip-header">
      <button type="button" className="pip-heading" disabled={busy} aria-expanded={!settings.collapsed} aria-controls={contentId}
        onClick={() => update({ collapsed: !settings.collapsed })}>
        <Icon name="chevron" size={12} style={{ transform: settings.collapsed ? undefined : 'rotate(90deg)' }} />
        <span>Pip</span>
      </button>
      {settings.collapsed && waitingButton}
      <label className="pip-quiet"><input type="checkbox" checked={settings.quiet} disabled={busy}
        onChange={event => update({ quiet: event.target.checked })} /> Quiet</label>
      <button type="button" className="icon-button" disabled={busy} aria-label="Hide Pip" title="Hide Pip (View menu to reopen)"
        onClick={() => update({ enabled: false })}><Icon name="close" size={13} /></button>
    </div>
    {pip.active && settings.nudges && <PipNudgeFeed updateVersion={updateVersion} onChange={receiveNudges} />}
    {pip.active && <div id={contentId} className="pip-content">
      <div className="pip-speech">{pip.line}</div>
      <span className="pip-announcement" role="status" aria-atomic="true">{pip.announcement}</span>
      <div className="pip-stage">
        <span className="pip-ground" aria-hidden="true" />
        <button type="button" className="pip-pet-button" aria-label={`Pet Pip. ${PIP_MOOD_LABELS[pip.mood]}.`}
          title="Pet Pip" onClick={pip.pet}><PipArtwork /></button>
        <span className="pip-emote" aria-hidden="true">{pip.emote}</span>
      </div>
      <div className="pip-footer">
        <span className="pip-following" title={pip.following}>{pip.following}</span>
        {waitingButton ?? <span className="pip-mood">{PIP_MOOD_LABELS[pip.mood]}</span>}
      </div>
      <button type="button" className="pip-options-toggle" aria-expanded={optionsOpen} aria-controls={optionsId}
        onClick={() => setOptionsOpen(value => !value)}>Pip options</button>
      {optionsOpen && <div id={optionsId} className="pip-options">
        <label>Personality <select value={settings.personality} disabled={busy}
          onChange={event => update({ personality: event.target.value === 'sweet' ? 'sweet' : 'dry' })}>
          <option value="dry">Dry little gremlin</option><option value="sweet">Cozy companion</option>
        </select></label>
        <label><input type="checkbox" checked={settings.motion} disabled={busy}
          onChange={event => update({ motion: event.target.checked })} /> Ambient motion</label>
        <label><input type="checkbox" checked={settings.nudges} disabled={busy}
          onChange={event => update({ nudges: event.target.checked })} /> Operational nudges</label>
        <p className="pip-options-help">One comment when Vault sign-in is about to expire, a quota passes 90%, a usage budget is crossed, or an update is available. Local only.</p>
        <label>AI quips <select value={settings.aiComments ? settings.aiBackend : 'off'} disabled={busy}
          onChange={event => {
            const value = event.target.value;
            update(value === 'codex' || value === 'claude' ? { aiComments: true, aiBackend: value } : { aiComments: false });
          }}>
          <option value="off">Off</option>
          <option value="codex">Codex ({CLI_TOOL_REGISTRY.codex.pipQuips?.account})</option>
          <option value="claude">Claude ({CLI_TOOL_REGISTRY.claude.pipQuips?.account})</option>
        </select></label>
        <p className="pip-options-help">{settings.aiComments ? BACKEND_HELP[settings.aiBackend] : 'Local quips only. Choose Codex or Claude for occasional generated comments.'}</p>
        {settings.aiComments && <>
          <output className="pip-ai-backend" data-ready={backend.status?.ready ?? undefined}>
            {backend.checking ? 'Checking sign-in…' : backend.status?.detail ?? ''}
          </output>
          <button type="button" className="pip-try-quip" disabled={busy || settings.quiet || pip.comments.pending}
            onClick={pip.tryQuip}>Try a quip</button>
          <p className="pip-options-help">Asks for one quip now. It counts toward the hourly limit.</p>
          <label><input type="checkbox" checked={settings.sharePrompts} disabled={busy}
            onChange={event => update({ sharePrompts: event.target.checked })} /> Share submitted prompts</label>
          <p className="pip-options-help">Sends up to 400 characters from the latest local Claude/Codex prompt to {recipient} for specific jokes. Common secrets are scrubbed; private text can remain. Draft typing and terminal output stay local. Choosing another AI backend turns this off.</p>
          <output className="pip-ai-status">{pipActivityStatus(settings.quiet, pip.comments)}</output>
        </>}
      </div>}
    </div>}
  </section>;
}
