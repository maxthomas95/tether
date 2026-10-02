import { Icon } from '../Icon';

interface SidebarUtilitiesProps {
  waitingCount: number;
  nextWaitingShortcut: string;
  onOpenSettings: () => void;
  onJumpToNextWaiting: () => void;
}

/** The attention badge shares the permanent Settings row to avoid layout shifts. */
export function SidebarUtilities({ waitingCount, nextWaitingShortcut, onOpenSettings, onJumpToNextWaiting }: SidebarUtilitiesProps) {
  return (
    <div className="sidebar-utilities">
      <button className="sidebar-settings" onClick={onOpenSettings}><Icon name="settings" /> Settings</button>
      {waitingCount > 0 && (
        <button
          type="button"
          className="attention-queue-pill"
          onClick={onJumpToNextWaiting}
          title={nextWaitingShortcut
            ? `Jump to next waiting session (${nextWaitingShortcut})`
            : 'Jump to next waiting session'}
          aria-label={`${waitingCount} session${waitingCount === 1 ? '' : 's'} waiting — jump to next`}
        >
          <span className="status-dot status-dot--waiting" aria-hidden="true" />
          <span className="attention-queue-label">{waitingCount} waiting</span>
        </button>
      )}
    </div>
  );
}
