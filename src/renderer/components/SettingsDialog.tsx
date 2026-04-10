import { useState, useEffect, useCallback } from 'react';
import { EnvVarEditor } from './EnvVarEditor';
import { MigrateToVaultDialog } from './MigrateToVaultDialog';
import { themeList } from '../styles/themes';
import type { GitProviderInfo, GitProviderType, LaunchProfileInfo, CreateLaunchProfileOptions, VaultConfig, VaultStatus } from '../../shared/types';

const COMMON_FLAGS = [
  { flag: '--dangerously-skip-permissions', label: 'Skip permission prompts' },
  { flag: '--verbose', label: 'Verbose output' },
  { flag: '--no-telemetry', label: 'Disable telemetry' },
];

const VAULT_REF_PREFIX = 'vault://';

function formatExpiry(expiresAt?: string): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return expiresAt;
  if (ms <= 0) return 'expired';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

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
  const [resumePreviousChats, setResumePreviousChats] = useState(true);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Profile state
  const [profiles, setProfiles] = useState<LaunchProfileInfo[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileEnvVars, setNewProfileEnvVars] = useState<Record<string, string>>({});
  const [newProfileCliFlags, setNewProfileCliFlags] = useState<string[]>([]);
  const [showNewProfile, setShowNewProfile] = useState(false);

  // Git provider state
  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<GitProviderType>('gitea');
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderUrl, setNewProviderUrl] = useState('');
  const [newProviderOrg, setNewProviderOrg] = useState('');
  const [newProviderToken, setNewProviderToken] = useState('');
  const [newProviderTokenFromVault, setNewProviderTokenFromVault] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});

  // Vault state
  const [vaultConfig, setVaultConfig] = useState<VaultConfig>({
    enabled: false, addr: '', role: '', mount: 'secret', namespace: '',
  });
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>({ enabled: false, loggedIn: false });
  const [vaultLoginError, setVaultLoginError] = useState<string | null>(null);
  const [vaultLoggingIn, setVaultLoggingIn] = useState(false);
  const [showMigrateDialog, setShowMigrateDialog] = useState(false);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    Promise.all([
      window.electronAPI.config.getDefaultEnvVars?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('restoreOnLaunch')?.catch(() => null),
      window.electronAPI.config.getDefaultCliFlags?.()?.catch(() => []),
      window.electronAPI.config.get?.('resumePreviousChats')?.catch(() => null),
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
    ]).then(([vars, restore, flags, resumeChats, badge, picker]) => {
      setEnvVars(vars || {});
      setRestoreOnLaunch(restore !== 'false');
      setCliFlags(flags || []);
      setResumePreviousChats(resumeChats !== 'false');
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
      setLoaded(true);
    });
    window.electronAPI.profile.list().then(setProfiles).catch(() => {});
    window.electronAPI.gitProvider.list().then(setGitProviders).catch(() => {});
    window.electronAPI.vault.getConfig().then(setVaultConfig).catch(() => {});
    window.electronAPI.vault.status().then(setVaultStatus).catch(() => {});
  }, [isOpen]);

  // Live status updates from main
  useEffect(() => {
    const unsub = window.electronAPI.vault.onStatusChange(setVaultStatus);
    return unsub;
  }, []);

  const handleSave = useCallback(async () => {
    await window.electronAPI.config.setDefaultEnvVars?.(envVars);
    await window.electronAPI.config.set?.('restoreOnLaunch', restoreOnLaunch ? 'true' : 'false');
    await window.electronAPI.config.set?.('resumePreviousChats', resumePreviousChats ? 'true' : 'false');
    await window.electronAPI.config.set?.('showResumeBadge', showResumeBadge ? 'true' : 'false');
    await window.electronAPI.config.set?.('enableResumePicker', enableResumePicker ? 'true' : 'false');
    await window.electronAPI.config.setDefaultCliFlags?.(cliFlags);
    await window.electronAPI.vault.setConfig(vaultConfig);
    onClose();
  }, [envVars, restoreOnLaunch, resumePreviousChats, showResumeBadge, enableResumePicker, cliFlags, vaultConfig, onClose]);

  const handleVaultLogin = async () => {
    setVaultLoginError(null);
    setVaultLoggingIn(true);
    try {
      // Persist the latest config first so the login flow uses it
      await window.electronAPI.vault.setConfig(vaultConfig);
      const status = await window.electronAPI.vault.login();
      setVaultStatus(status);
    } catch (err) {
      setVaultLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultLoggingIn(false);
    }
  };

  const handleVaultLogout = async () => {
    await window.electronAPI.vault.logout();
    const status = await window.electronAPI.vault.status();
    setVaultStatus(status);
  };

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
    if (newProviderTokenFromVault && !newProviderToken.startsWith(VAULT_REF_PREFIX)) return;
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
      setNewProviderTokenFromVault(false);
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

            <div style={{ marginLeft: 22, marginTop: 8, opacity: restoreOnLaunch ? 1 : 0.5 }}>
              <label className="form-radio-label">
                <input
                  type="checkbox"
                  checked={resumePreviousChats}
                  disabled={!restoreOnLaunch}
                  onChange={e => setResumePreviousChats(e.target.checked)}
                />
                Resume previous chats
              </label>
              <p className="form-hint">
                Reopen the same Claude conversation each session was on, instead of starting fresh.
                Local sessions only; SSH sessions always start fresh.
              </p>

              <label className="form-radio-label" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={showResumeBadge}
                  disabled={!restoreOnLaunch || !resumePreviousChats}
                  onChange={e => setShowResumeBadge(e.target.checked)}
                />
                Show a badge on resumed sessions
              </label>
              <p className="form-hint">
                Adds a small ↻ marker next to sessions that were resumed from a prior chat.
              </p>

              <label className="form-radio-label" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={enableResumePicker}
                  onChange={e => setEnableResumePicker(e.target.checked)}
                />
                Enable &ldquo;Resume previous chat…&rdquo; in the right-click menu
              </label>
              <p className="form-hint">
                Lets you manually pick an older Claude conversation for a session&rsquo;s working directory.
              </p>
            </div>
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

          {/* === Launch Profiles === */}
          {loaded && (
            <div className="form-group" style={{ marginTop: 20 }}>
              <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
                Launch Profiles
              </label>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Named presets of env vars and CLI flags. Pick a profile when creating a session to quickly switch between configurations (e.g. subscription vs API mode).
              </p>

              {profiles.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 8px', background: 'var(--bg-tertiary)', borderRadius: 4 }}>
                  <span style={{ flex: 1, fontWeight: 500 }}>
                    {p.name}
                    {p.isDefault && <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>(default)</span>}
                  </span>
                  {!p.isDefault && (
                    <button className="form-btn" style={{ fontSize: 11, padding: '2px 6px' }} onClick={async () => {
                      await window.electronAPI.profile.update(p.id, { isDefault: true });
                      const updated = await window.electronAPI.profile.list().catch(() => []);
                      setProfiles(updated);
                    }}>Set Default</button>
                  )}
                  <button className="form-btn" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => {
                    setEditingProfileId(p.id);
                    setNewProfileName(p.name);
                    setNewProfileEnvVars(p.envVars);
                    setNewProfileCliFlags(p.cliFlags);
                    setShowNewProfile(true);
                  }}>Edit</button>
                  <button className="env-editor-btn env-editor-btn--remove" onClick={async () => {
                    await window.electronAPI.profile.delete(p.id);
                    const updated = await window.electronAPI.profile.list().catch(() => []);
                    setProfiles(updated);
                  }}>&times;</button>
                </div>
              ))}

              {!showNewProfile && (
                <button className="form-btn" style={{ marginTop: 4 }} onClick={() => {
                  setEditingProfileId(null);
                  setNewProfileName('');
                  setNewProfileEnvVars({});
                  setNewProfileCliFlags([]);
                  setShowNewProfile(true);
                }}>Add Profile</button>
              )}

              {showNewProfile && (
                <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border-color)', borderRadius: 4 }}>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Profile Name</label>
                    <input
                      className="form-input"
                      value={newProfileName}
                      onChange={e => setNewProfileName(e.target.value)}
                      placeholder="e.g. API Mode"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Environment Variables</label>
                    <EnvVarEditor vars={newProfileEnvVars} onChange={setNewProfileEnvVars} compact />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">CLI Flags</label>
                    {newProfileCliFlags.map(flag => (
                      <div key={flag} className="cli-flag-custom">
                        <code className="cli-flag-code">{flag}</code>
                        <button
                          className="env-editor-btn env-editor-btn--remove"
                          onClick={() => setNewProfileCliFlags(prev => prev.filter(f => f !== flag))}
                        >&times;</button>
                      </div>
                    ))}
                    <div className="form-row">
                      <input
                        className="form-input"
                        placeholder="--flag-name"
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const f = (e.target as HTMLInputElement).value.trim();
                            if (f && !newProfileCliFlags.includes(f)) {
                              setNewProfileCliFlags(prev => [...prev, f]);
                              (e.target as HTMLInputElement).value = '';
                            }
                          }
                        }}
                      />
                      <button className="form-btn" onClick={e => {
                        const input = (e.target as HTMLElement).parentElement?.querySelector('input') as HTMLInputElement;
                        const f = input?.value?.trim();
                        if (f && !newProfileCliFlags.includes(f)) {
                          setNewProfileCliFlags(prev => [...prev, f]);
                          if (input) input.value = '';
                        }
                      }}>Add</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="form-btn form-btn--primary" onClick={async () => {
                      if (!newProfileName.trim()) return;
                      const opts: CreateLaunchProfileOptions = {
                        name: newProfileName.trim(),
                        envVars: Object.keys(newProfileEnvVars).length > 0 ? newProfileEnvVars : undefined,
                        cliFlags: newProfileCliFlags.length > 0 ? newProfileCliFlags : undefined,
                      };
                      if (editingProfileId) {
                        await window.electronAPI.profile.update(editingProfileId, opts);
                      } else {
                        await window.electronAPI.profile.create(opts);
                      }
                      const updated = await window.electronAPI.profile.list().catch(() => []);
                      setProfiles(updated);
                      setShowNewProfile(false);
                      setEditingProfileId(null);
                      setNewProfileName('');
                      setNewProfileEnvVars({});
                      setNewProfileCliFlags([]);
                    }}>
                      {editingProfileId ? 'Update' : 'Save'}
                    </button>
                    <button className="form-btn" onClick={() => {
                      setShowNewProfile(false);
                      setEditingProfileId(null);
                      setNewProfileName('');
                      setNewProfileEnvVars({});
                      setNewProfileCliFlags([]);
                    }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Default Environment Variables
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Applied to all sessions. Environments and sessions can override individual values.
            </p>
            {loaded && <EnvVarEditor vars={envVars} onChange={setEnvVars} vaultEnabled={vaultStatus.enabled} />}
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
                    {p.tokenIsVaultRef && (
                      <span
                        className="form-hint"
                        title={p.tokenVaultRef}
                        style={{ display: 'inline', marginLeft: 4, color: 'var(--accent)' }}
                      >
                        Vault
                      </span>
                    )}
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
                  {vaultStatus.enabled && (
                    <label className="form-radio-label" style={{ marginBottom: 4 }}>
                      <input
                        type="checkbox"
                        checked={newProviderTokenFromVault}
                        onChange={e => {
                          setNewProviderTokenFromVault(e.target.checked);
                          setNewProviderToken(e.target.checked ? VAULT_REF_PREFIX : '');
                        }}
                      />
                      Source from Vault
                    </label>
                  )}
                  <input
                    type={newProviderTokenFromVault ? 'text' : 'password'}
                    className="form-input"
                    value={newProviderToken}
                    onChange={e => setNewProviderToken(e.target.value)}
                    placeholder={newProviderTokenFromVault ? 'vault://secret/tether/git/name#token' : 'ghp_... or PAT'}
                    spellCheck={false}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="form-btn form-btn--primary" onClick={handleAddProvider}
                    disabled={
                      !newProviderName.trim() ||
                      !newProviderUrl.trim() ||
                      !newProviderToken.trim() ||
                      (newProviderTokenFromVault && !newProviderToken.startsWith(VAULT_REF_PREFIX))
                    }
                  >Save</button>
                  <button className="form-btn" onClick={() => {
                    setShowAddProvider(false);
                    setNewProviderName('');
                    setNewProviderUrl('');
                    setNewProviderOrg('');
                    setNewProviderToken('');
                    setNewProviderTokenFromVault(false);
                  }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Vault */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Vault Integration
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Source SSH passwords, API keys, and Git tokens from HashiCorp Vault.
              Secrets are resolved just-in-time and never written to disk.
            </p>

            <div className="form-group">
              <label className="form-radio-label">
                <input
                  type="checkbox"
                  checked={vaultConfig.enabled}
                  onChange={e => setVaultConfig(c => ({ ...c, enabled: e.target.checked }))}
                />
                Enable Vault integration
              </label>
            </div>

            {vaultConfig.enabled && (
              <>
                <div className="form-group">
                  <label className="form-label">Vault Address</label>
                  <input
                    className="form-input"
                    value={vaultConfig.addr}
                    onChange={e => setVaultConfig(c => ({ ...c, addr: e.target.value }))}
                    placeholder="https://vault.example.com"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">OIDC Role</label>
                  <input
                    className="form-input"
                    value={vaultConfig.role}
                    onChange={e => setVaultConfig(c => ({ ...c, role: e.target.value }))}
                    placeholder="default"
                    spellCheck={false}
                  />
                  <p className="form-hint">The Vault OIDC role to log in with.</p>
                </div>
                <div className="form-group">
                  <label className="form-label">KV Mount Path</label>
                  <input
                    className="form-input"
                    value={vaultConfig.mount}
                    onChange={e => setVaultConfig(c => ({ ...c, mount: e.target.value }))}
                    placeholder="secret"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Namespace (optional)</label>
                  <input
                    className="form-input"
                    value={vaultConfig.namespace || ''}
                    onChange={e => setVaultConfig(c => ({ ...c, namespace: e.target.value }))}
                    placeholder=""
                    spellCheck={false}
                  />
                  <p className="form-hint">Leave blank if not using Vault Enterprise namespaces.</p>
                </div>

                <div className="form-group">
                  <label className="form-label">Status</label>
                  <div style={{ marginTop: 4 }}>
                    {vaultStatus.loggedIn ? (
                      <span className="form-hint" style={{ color: 'var(--status-running)' }}>
                        {'\u25CF'} Logged in
                        {vaultStatus.identity ? ` as ${vaultStatus.identity}` : ''}
                        {vaultStatus.expiresAt ? `, expires ${formatExpiry(vaultStatus.expiresAt)}` : ''}
                      </span>
                    ) : (
                      <span className="form-hint" style={{ color: 'var(--text-muted)' }}>
                        {'\u25CB'} Not logged in
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {vaultStatus.loggedIn ? (
                      <button className="form-btn" onClick={handleVaultLogout}>Log Out</button>
                    ) : (
                      <button
                        className="form-btn form-btn--primary"
                        onClick={handleVaultLogin}
                        disabled={vaultLoggingIn || !vaultConfig.addr || !vaultConfig.role}
                      >
                        {vaultLoggingIn ? 'Opening browser…' : 'Log In'}
                      </button>
                    )}
                    <button className="form-btn" onClick={() => setShowMigrateDialog(true)} disabled={!vaultStatus.loggedIn}>
                      Migrate Existing Secrets…
                    </button>
                  </div>
                  {vaultLoginError && (
                    <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 6 }}>
                      {vaultLoginError}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button className="form-btn form-btn--primary" onClick={handleSave}>Save</button>
        </div>
      </div>
      <MigrateToVaultDialog isOpen={showMigrateDialog} onClose={() => setShowMigrateDialog(false)} />
    </div>
  );
}
