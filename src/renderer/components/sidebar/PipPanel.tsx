import { useId, useState } from 'react';
import { Icon } from '../Icon';
import { usePip } from '../../hooks/usePip';
import { PIP_MOOD_LABELS, pipSessionLabel, type PipSession } from '../../lib/pip-behavior';
import type { PipSettings } from '../../lib/pip-settings';
import './pip-panel.css';

interface PipPanelProps {
  settings: PipSettings;
  sessions: readonly PipSession[];
  activeSessionId: string | null;
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

export function PipPanel({ settings, sessions, activeSessionId, busy, onSettingsChange, onActivateSession }: Readonly<PipPanelProps>) {
  const pip = usePip(sessions, activeSessionId, settings);
  const contentId = useId();
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const waiting = sessions.filter(session => session.id !== activeSessionId && session.state === 'waiting');
  const nextWaiting = waiting.find(session => session.waitingReason === 'permission') ?? waiting[0];
  const update = (patch: Partial<PipSettings>) => { void onSettingsChange(patch); };

  return <section className="pip-panel" aria-label="Pip sidebar pet" ref={pip.panelRef}
    data-mood={pip.mood} data-motion={pip.motionAllowed} data-quiet={settings.quiet}>
    <div className="pip-header">
      <button type="button" className="pip-heading" disabled={busy} aria-expanded={!settings.collapsed} aria-controls={contentId}
        onClick={() => update({ collapsed: !settings.collapsed })}>
        <Icon name="chevron" size={12} style={{ transform: settings.collapsed ? undefined : 'rotate(90deg)' }} />
        <span>Pip</span>
      </button>
      <label className="pip-quiet"><input type="checkbox" checked={settings.quiet} disabled={busy}
        onChange={event => update({ quiet: event.target.checked })} /> Quiet</label>
      <button type="button" className="icon-button" disabled={busy} aria-label="Hide Pip" title="Hide Pip (View menu to reopen)"
        onClick={() => update({ enabled: false })}><Icon name="close" size={13} /></button>
    </div>
    {pip.active && <div id={contentId} className="pip-content">
      <div className="pip-speech" role="status" aria-live="polite" aria-atomic="true">{pip.line}</div>
      <div className="pip-stage">
        <span className="pip-ground" aria-hidden="true" />
        <button type="button" className="pip-pet-button" aria-label={`Pet Pip. ${PIP_MOOD_LABELS[pip.mood]}.`}
          title="Pet Pip" onClick={pip.pet}><PipArtwork /></button>
        <span className="pip-emote" aria-hidden="true">{pip.emote}</span>
      </div>
      <div className="pip-footer">
        <span className="pip-following" title={pip.following}>{pip.following}</span>
        {nextWaiting ? <button type="button" className="pip-waiting" onClick={() => onActivateSession(nextWaiting.id)}
          title={`View ${pipSessionLabel(nextWaiting)}`} aria-label={`View ${pipSessionLabel(nextWaiting)}; ${waiting.length} other session${waiting.length === 1 ? '' : 's'} waiting`}>
          {waiting.length} waiting <Icon name="chevron" size={10} />
        </button> : <span className="pip-mood">{PIP_MOOD_LABELS[pip.mood]}</span>}
      </div>
      <button type="button" className="pip-options-toggle" aria-expanded={optionsOpen} aria-controls={optionsId}
        onClick={() => setOptionsOpen(value => !value)}>Personality &amp; comments</button>
      {optionsOpen && <div id={optionsId} className="pip-options">
        <label>Personality <select value={settings.personality} disabled={busy}
          onChange={event => update({ personality: event.target.value === 'sweet' ? 'sweet' : 'dry' })}>
          <option value="dry">Dry little gremlin</option><option value="sweet">Cozy companion</option>
        </select></label>
        <label><input type="checkbox" checked={settings.motion} disabled={busy}
          onChange={event => update({ motion: event.target.checked })} /> Ambient motion</label>
        <label><input type="checkbox" checked={settings.aiComments} disabled={busy}
          onChange={event => update({ aiComments: event.target.checked })} /> AI quips through Codex</label>
        <p className="pip-options-help">Uses your local Codex ChatGPT sign-in and subscription allowance. Luna only; up to 12 quips/hour.</p>
        {settings.aiComments && <>
          <label><input type="checkbox" checked={settings.sharePrompts} disabled={busy}
            onChange={event => update({ sharePrompts: event.target.checked })} /> Share submitted prompts</label>
          <p className="pip-options-help">Sends up to 400 characters from the latest local Claude/Codex prompt to OpenAI for specific jokes. Common secrets are scrubbed; private text can remain. Draft typing and terminal output stay local.</p>
          <span className="pip-ai-status" role="status">{settings.quiet ? 'AI paused while Quiet is on.' : pip.comments.pending ? 'Thinking of a quip…' : pip.comments.result?.reason ?? (pip.comments.result?.model ? `Quip via ${pip.comments.result.model}` : 'AI on. Waiting for a session moment.')}</span>
        </>}
      </div>}
    </div>}
  </section>;
}
