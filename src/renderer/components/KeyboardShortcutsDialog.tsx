interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: 'Ctrl+N', action: 'New session' },
  { keys: 'Ctrl+W', action: 'Stop current session' },
  { keys: 'Ctrl+B', action: 'Toggle sidebar' },
  { keys: 'Ctrl+,', action: 'Open settings' },
  { keys: 'Ctrl+1\u20139', action: 'Switch to session 1\u20139' },
  { keys: 'Ctrl+\u2191', action: 'Previous session' },
  { keys: 'Ctrl+\u2193', action: 'Next session' },
];

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span>Keyboard Shortcuts</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <table className="shortcuts-table">
            <tbody>
              {SHORTCUTS.map(({ keys, action }) => (
                <tr key={keys}>
                  <td className="shortcuts-key"><kbd>{keys}</kbd></td>
                  <td className="shortcuts-action">{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
