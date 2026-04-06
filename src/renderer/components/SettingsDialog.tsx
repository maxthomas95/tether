import { useState, useEffect, useCallback } from 'react';
import { EnvVarEditor } from './EnvVarEditor';
import { themeList } from '../styles/themes';

const COMMON_FLAGS = [
  { flag: '--dangerously-skip-permissions', label: 'Skip permission prompts' },
  { flag: '--verbose', label: 'Verbose output' },
  { flag: '--no-telemetry', label: 'Disable telemetry' },
];

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: string;
  onThemeChange: (name: string) => void;
}

export function SettingsDialog({ isOpen, onClose, currentTheme, onThemeChange }: SettingsDialogProps) {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [cliFlags, setCliFlags] = useState<string[]>([]);
  const [customFlag, setCustomFlag] = useState('');
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    Promise.all([
      window.electronAPI.config.getDefaultEnvVars?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('restoreOnLaunch')?.catch(() => null),
      window.electronAPI.config.getDefaultCliFlags?.()?.catch(() => []),
    ]).then(([vars, restore, flags]) => {
      setEnvVars(vars || {});
      setRestoreOnLaunch(restore !== 'false');
      setCliFlags(flags || []);
      setLoaded(true);
    });
  }, [isOpen]);

  const handleSave = useCallback(async () => {
    await window.electronAPI.config.setDefaultEnvVars?.(envVars);
    await window.electronAPI.config.set?.('restoreOnLaunch', restoreOnLaunch ? 'true' : 'false');
    await window.electronAPI.config.setDefaultCliFlags?.(cliFlags);
    onClose();
  }, [envVars, restoreOnLaunch, cliFlags, onClose]);

  const toggleFlag = (flag: string) => {
    setCliFlags(prev =>
      prev.includes(flag) ? prev.filter(f => f !== flag) : [...prev, flag],
    );
  };

  const addCustomFlag = () => {
    const f = customFlag.trim();
    if (f && !cliFlags.includes(f)) {
      setCliFlags(prev => [...prev, f]);
      setCustomFlag('');
    }
  };

  const removeFlag = (flag: string) => {
    setCliFlags(prev => prev.filter(f => f !== flag));
  };

  if (!isOpen) return null;

  const commonFlagSet = new Set(COMMON_FLAGS.map(f => f.flag));
  const extraFlags = cliFlags.filter(f => !commonFlagSet.has(f));

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span>Settings</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="form-group">
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Theme
            </label>
            <select
              className="form-input"
              value={currentTheme}
              onChange={e => onThemeChange(e.target.value)}
            >
              {themeList.map(t => (
                <option key={t.name} value={t.name}>{t.label}</option>
              ))}
            </select>
          </div>

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
              Claude Code CLI Flags
            </label>
            <p className="form-hint" style={{ marginBottom: 8 }}>
              Applied to all sessions. These flags are passed to the <code>claude</code> command.
            </p>

            {loaded && (
              <>
                {COMMON_FLAGS.map(({ flag, label }) => (
                  <label key={flag} className="form-radio-label" style={{ marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={cliFlags.includes(flag)}
                      onChange={() => toggleFlag(flag)}
                    />
                    <code className="cli-flag-code">{flag}</code>
                    <span className="form-hint" style={{ display: 'inline', marginLeft: 6 }}>{label}</span>
                  </label>
                ))}

                {extraFlags.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {extraFlags.map(flag => (
                      <div key={flag} className="cli-flag-custom">
                        <code className="cli-flag-code">{flag}</code>
                        <button className="env-editor-btn env-editor-btn--remove" onClick={() => removeFlag(flag)}>&times;</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="form-row" style={{ marginTop: 8 }}>
                  <input
                    className="form-input"
                    value={customFlag}
                    onChange={e => setCustomFlag(e.target.value)}
                    placeholder="--custom-flag"
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomFlag(); } }}
                  />
                  <button className="form-btn" onClick={addCustomFlag}>Add Flag</button>
                </div>
              </>
            )}
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
