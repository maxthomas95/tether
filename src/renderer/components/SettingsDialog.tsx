import { useState, useEffect, useCallback } from 'react';
import { EnvVarEditor } from './EnvVarEditor';
import { themeList } from '../styles/themes';
import type { GitProviderInfo, GitProviderType } from '../../shared/types';

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

  // Git provider state
  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<GitProviderType>('gitea');
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderUrl, setNewProviderUrl] = useState('');
  const [newProviderOrg, setNewProviderOrg] = useState('');
  const [newProviderToken, setNewProviderToken] = useState('');
  const [providerTestResult, setProviderTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});

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
    window.electronAPI.gitProvider.list().then(setGitProviders).catch(() => {});
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

  const handleAddProvider = async () => {
    if (!newProviderName.trim() || !newProviderUrl.trim() || !newProviderToken.trim()) return;
    try {
      const provider = await window.electronAPI.gitProvider.create({
        name: newProviderName.trim(),
        type: newProviderType,
        baseUrl: newProviderUrl.trim(),
        organization: newProviderType === 'ado' ? newProviderOrg.trim() : undefined,
        token: newProviderToken.trim(),
      });
      setGitProviders(prev => [...prev, provider]);
      setShowAddProvider(false);
      setNewProviderName('');
      setNewProviderUrl('');
      setNewProviderOrg('');
      setNewProviderToken('');
    } catch { /* ignore */ }
  };

  const handleDeleteProvider = async (id: string) => {
    await window.electronAPI.gitProvider.delete(id);
    setGitProviders(prev => prev.filter(p => p.id !== id));
    setProviderTestResult(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  const handleTestProvider = async (id: string) => {
    setProviderTestResult(prev => ({ ...prev, [id]: { ok: false, error: 'Testing...' } }));
    const result = await window.electronAPI.gitProvider.test(id);
    setProviderTestResult(prev => ({ ...prev, [id]: result }));
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

          {/* Git Providers */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Git Providers
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Connect to Gitea or Azure DevOps to browse and clone repos from the New Session dialog.
            </p>

            {gitProviders.length > 0 && (
              <div className="provider-list">
                {gitProviders.map(p => (
                  <div key={p.id} className="provider-row">
                    <span className="provider-type-badge">{p.type}</span>
                    <span className="provider-name">{p.name}</span>
                    <span className="provider-url">{p.baseUrl}</span>
                    <button className="env-editor-btn" onClick={() => handleTestProvider(p.id)}>
                      Test
                    </button>
                    <button className="env-editor-btn env-editor-btn--remove" onClick={() => handleDeleteProvider(p.id)}>
                      &times;
                    </button>
                    {providerTestResult[p.id] && (
                      <span className="form-hint" style={{
                        display: 'inline',
                        marginLeft: 4,
                        color: providerTestResult[p.id].ok ? 'var(--status-running)' : 'var(--status-dead)',
                      }}>
                        {providerTestResult[p.id].ok ? 'OK' : (providerTestResult[p.id].error || 'Failed')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!showAddProvider && (
              <button className="env-editor-btn" onClick={() => setShowAddProvider(true)}>
                Add Provider
              </button>
            )}

            {showAddProvider && (
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 4, padding: 12, marginTop: 8 }}>
                <div className="form-group">
                  <label className="form-label">Type</label>
                  <select
                    className="form-input"
                    value={newProviderType}
                    onChange={e => setNewProviderType(e.target.value as GitProviderType)}
                  >
                    <option value="gitea">Gitea</option>
                    <option value="ado">Azure DevOps</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input
                    className="form-input"
                    value={newProviderName}
                    onChange={e => setNewProviderName(e.target.value)}
                    placeholder="My Gitea Server"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Base URL</label>
                  <input
                    className="form-input"
                    value={newProviderUrl}
                    onChange={e => setNewProviderUrl(e.target.value)}
                    placeholder={newProviderType === 'gitea' ? 'https://gitea.example.com' : 'https://dev.azure.com'}
                  />
                </div>
                {newProviderType === 'ado' && (
                  <div className="form-group">
                    <label className="form-label">Organization</label>
                    <input
                      className="form-input"
                      value={newProviderOrg}
                      onChange={e => setNewProviderOrg(e.target.value)}
                      placeholder="my-org"
                    />
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label">Personal Access Token</label>
                  <input
                    type="password"
                    className="form-input"
                    value={newProviderToken}
                    onChange={e => setNewProviderToken(e.target.value)}
                    placeholder="ghp_... or PAT"
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="form-btn form-btn--primary" onClick={handleAddProvider}
                    disabled={!newProviderName.trim() || !newProviderUrl.trim() || !newProviderToken.trim()}
                  >Save</button>
                  <button className="form-btn" onClick={() => {
                    setShowAddProvider(false);
                    setNewProviderName('');
                    setNewProviderUrl('');
                    setNewProviderOrg('');
                    setNewProviderToken('');
                  }}>Cancel</button>
                </div>
              </div>
            )}
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
