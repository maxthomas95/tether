import type { JobsStatus } from '../../../shared/types';
import { onKeyActivate } from '../../utils/a11y';

interface JobsOfficePillProps {
  status: JobsStatus | null;
  active: boolean;
  onToggle: () => void;
}

/**
 * Sidebar footer pill that lights up when a J.O.B.S. office server is
 * detected. Hidden entirely otherwise — users who don't run JOBS never
 * see it. Click toggles the Office pane.
 */
export function JobsOfficePill({ status, active, onToggle }: Readonly<JobsOfficePillProps>) {
  if (!status?.detected) return null;

  const title = [
    `J.O.B.S. office at ${status.url}`,
    status.version ? `v${status.version}` : null,
    status.managed ? 'launched by Tether' : 'externally managed',
    active ? 'Click to close the office view' : 'Click to open the office view',
  ].filter(Boolean).join(' · ');

  return (
    <div
      className="sidebar-footer"
      role="button"
      tabIndex={0}
      title={title}
      onClick={onToggle}
      onKeyDown={onKeyActivate(onToggle)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer' }}
    >
      <span style={{ color: 'var(--status-running)', fontSize: 10, lineHeight: 1 }}>{'●'}</span>
      <span style={{ fontSize: 11, color: active ? 'var(--text)' : 'var(--text-secondary)' }}>
        {active ? 'Office (open)' : 'Office'}
      </span>
    </div>
  );
}
