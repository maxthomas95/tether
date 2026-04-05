import { useState, useEffect, useCallback } from 'react';
import { EnvVarEditor } from './EnvVarEditor';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    Promise.all([
      window.electronAPI.config.getDefaultEnvVars?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('restoreOnLaunch')?.catch(() => null),
    ]).then(([vars, restore]) => {
      setEnvVars(vars || {});
      setRestoreOnLaunch(restore !== 'false'); // default true
      setLoaded(true);
    });
  }, [isOpen]);

  const handleSave = useCallback(async () => {
    await window.electronAPI.config.setDefaultEnvVars?.(envVars);
    await window.electronAPI.config.set?.('restoreOnLaunch', restoreOnLaunch ? 'true' : 'false');
    onClose();
  }, [envVars, restoreOnLaunch, onClose]);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span>Settings</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={restoreOnLaunch}
                onChange={e => setRestoreOnLaunch(e.target.checked)}
              />
              Restore sessions on launch
            </label>
            <p className="form-hint">
              Automatically reopen your sessions when Tether starts.
            </p>
          </div>

          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Default Environment Variables
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Applied to all sessions. Environments and sessions can override individual values.
            </p>
            {loaded && <EnvVarEditor vars={envVars} onChange={setEnvVars} />}
          </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button className="form-btn form-btn--primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
