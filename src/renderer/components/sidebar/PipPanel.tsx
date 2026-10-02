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
    <span className="pip-tail" /><span className="pip-body"><span className="pip-belly" /></span>
    <span className="pip-paw pip-paw-left" /><span className="pip-paw pip-paw-right" />
    <span className="pip-head"><span className="pip-ear pip-ear-left" /><span className="pip-ear pip-ear-right" />
      <span className="pip-face"><span className="pip-eye pip-eye-left"><span className="pip-pupil" /></span><span className="pip-eye pip-eye-right"><span className="pip-pupil" /></span><span className="pip-nose" /><span className="pip-mouth" /><span className="pip-cheek pip-cheek-left" /><span className="pip-cheek pip-cheek-right" /></span>
    </span>
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
        onClick={() => setOptionsOpen(value => !value)}>Personality &amp; motion</button>
      {optionsOpen && <div id={optionsId} className="pip-options">
        <label>Personality <select value={settings.personality} disabled={busy}
          onChange={event => update({ personality: event.target.value === 'sweet' ? 'sweet' : 'dry' })}>
          <option value="dry">Dry little gremlin</option><option value="sweet">Cozy companion</option>
        </select></label>
        <label><input type="checkbox" checked={settings.motion} disabled={busy}
          onChange={event => update({ motion: event.target.checked })} /> Ambient motion</label>
      </div>}
    </div>}
  </section>;
}
