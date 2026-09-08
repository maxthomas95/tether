import type { JobsStatus } from '../../../shared/types';
import { onKeyActivate } from '../../utils/a11y';

interface JobsOfficePillProps {
  status: JobsStatus | null;
  active: boolean;
  onToggle: () => void;
  onConfigure: () => void;
}

/**
 * Sidebar footer pill that lights up when a J.O.B.S. office server is
 * enabled. Keep unavailable offices discoverable so users can repair or
 * remove their integration. Opted-out users see no pill.
 */
export function JobsOfficePill({ status, active, onToggle, onConfigure }: Readonly<JobsOfficePillProps>) {
  if (!status || status.enabled === 'off') return null;

  const connecting = status.phase === 'checking' || status.phase === 'starting';
  const activate = status.detected ? onToggle : onConfigure;

  const title = [
    `J.O.B.S. office at ${status.url}`,
    status.version ? `v${status.version}` : null,
    status.managed ? 'launched by Tether' : 'externally managed',
    status.detected ? 'Click to toggle the office view' : 'Click to configure the office connection',
    status.error,
  ].filter(Boolean).join(' · ');

  return (
    <div
      className="sidebar-footer"
      role="button"
      tabIndex={0}
      title={title}
      onClick={activate}
      onKeyDown={onKeyActivate(activate)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer' }}
    >
      <span style={{ color: status.detected ? 'var(--status-running)' : 'var(--status-waiting)', fontSize: 10, lineHeight: 1 }}>{'●'}</span>
      <span style={{ fontSize: 11, color: active ? 'var(--text)' : 'var(--text-secondary)' }}>
        {status.detected ? active ? 'Office (open)' : 'Office' : connecting ? 'Office connecting…' : 'Office unavailable · Settings'}
      </span>
    </div>
  );
}
