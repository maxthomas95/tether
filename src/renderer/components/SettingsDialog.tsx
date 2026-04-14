import { useState, useEffect, useCallback } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { EnvVarEditor } from './EnvVarEditor';
import { MigrateToVaultDialog } from './MigrateToVaultDialog';
import { themeList } from '../styles/themes';
import { suggestVaultPath } from '../utils/vault-path';
import type { GitProviderInfo, GitProviderType, LaunchProfileInfo, CreateLaunchProfileOptions, VaultConfig, VaultStatus, CliToolId, KnownHostInfo } from '../../shared/types';
import { CLI_TOOL_REGISTRY } from '../../shared/cli-tools';

/** CLI tools that have definable flags (exclude 'custom' which has no known flags). */
const FLAG_TOOLS = (['claude', 'codex', 'opencode'] as const) satisfies readonly CliToolId[];

function compactFlagsPerTool(flags: Partial<Record<CliToolId, string[]>>): Partial<Record<CliToolId, string[]>> {
  const result: Partial<Record<CliToolId, string[]>> = {};
  for (const toolId of FLAG_TOOLS) {
    const toolFlags = flags[toolId]?.filter(Boolean) || [];
    if (toolFlags.length > 0) {
      result[toolId] = toolFlags;
    }
  }
  return result;
}

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
  const [cliFlagsPerTool, setCliFlagsPerTool] = useState<Partial<Record<CliToolId, string[]>>>({});
  const [flagTool, setFlagTool] = useState<CliToolId>('claude');
  const [customFlag, setCustomFlag] = useState('');
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(true);
  const [resumePreviousChats, setResumePreviousChats] = useState(true);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [enablePaneSplitting, setEnablePaneSplitting] = useState(false);
  const [maxPanes, setMaxPanes] = useState(4);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);
  const [quotaEnabled, setQuotaEnabled] = useState(true);
  const [usageStripEnabled, setUsageStripEnabled] = useState(true);
  const [globalUsageEnabled, setGlobalUsageEnabled] = useState(true);
  const [hideTerminalCursor, setHideTerminalCursor] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Profile state
  const [profiles, setProfiles] = useState<LaunchProfileInfo[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileEnvVars, setNewProfileEnvVars] = useState<Record<string, string>>({});
  const [newProfileCliFlagsPerTool, setNewProfileCliFlagsPerTool] = useState<Partial<Record<CliToolId, string[]>>>({});
  const [profileFlagTool, setProfileFlagTool] = useState<CliToolId>('claude');
  const [showNewProfile, setShowNewProfile] = useState(false);

  // SSH known hosts
  const [knownHosts, setKnownHosts] = useState<KnownHostInfo[]>([]);

  // Git provider state
  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<GitProviderType>('gitea');
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderUrl, setNewProviderUrl] = useState('');
  const [newProviderOrg, setNewProviderOrg] = useState('');
  const [newProviderToken, setNewProviderToken] = useState('');
  const [newProviderStoreInVault, setNewProviderStoreInVault] = useState(false);
  const [newProviderVaultPath, setNewProviderVaultPath] = useState('');
  const [newProviderError, setNewProviderError] = useState<string | null>(null);
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
      window.electronAPI.config.getDefaultCliFlagsPerTool?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('resumePreviousChats')?.catch(() => null),
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
      window.electronAPI.config.get?.('enablePaneSplitting')?.catch(() => null),
      window.electronAPI.config.get?.('maxPanes')?.catch(() => null),
      window.electronAPI.config.get?.('updateCheckEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('quotaEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('usageStripEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('globalUsageEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('hideTerminalCursor')?.catch(() => null),
    ]).then(([vars, restore, perToolFlags, resumeChats, badge, picker, splitting, maxPaneValue, updateCheck, quota, usageStrip, globalUsage, hideCursor]) => {
      setEnvVars(vars || {});
      setRestoreOnLaunch(restore !== 'false');
      setCliFlagsPerTool(perToolFlags || {});
      setResumePreviousChats(resumeChats !== 'false');
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
      setEnablePaneSplitting(splitting === 'true');
      setMaxPanes(parseMaxPanes(maxPaneValue));
      setUpdateCheckEnabled(updateCheck !== 'false');
      setQuotaEnabled(quota !== 'false');
      setUsageStripEnabled(usageStrip !== 'false');
      setGlobalUsageEnabled(globalUsage !== 'false');
      setHideTerminalCursor(hideCursor === 'true');
      setLoaded(true);
    });
    window.electronAPI.profile.list().then(setProfiles).catch(() => {});
    window.electronAPI.gitProvider.list().then(setGitProviders).catch(() => {});
    window.electronAPI.knownHosts.list().then(setKnownHosts).catch(() => {});
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
    await window.electronAPI.config.set?.('enablePaneSplitting', enablePaneSplitting ? 'true' : 'false');
    await window.electronAPI.config.set?.('maxPanes', String(maxPanes));
    await window.electronAPI.config.set?.('updateCheckEnabled', updateCheckEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('quotaEnabled', quotaEnabled ? 'true' : 'false');
    await window.electronAPI.quota.setEnabled(quotaEnabled);
    await window.electronAPI.config.set?.('usageStripEnabled', usageStripEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('globalUsageEnabled', globalUsageEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('hideTerminalCursor', hideTerminalCursor ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent('tether:settings-changed'));
    for (const toolId of FLAG_TOOLS) {
      await window.electronAPI.config.setDefaultCliFlagsForTool?.(toolId, cliFlagsPerTool[toolId] || []);
    }
    await window.electronAPI.vault.setConfig(vaultConfig);
    onClose();
  }, [envVars, restoreOnLaunch, resumePreviousChats, showResumeBadge, enableResumePicker, enablePaneSplitting, maxPanes, updateCheckEnabled, quotaEnabled, usageStripEnabled, globalUsageEnabled, hideTerminalCursor, cliFlagsPerTool, vaultConfig, onClose]);

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

  const currentToolFlags = cliFlagsPerTool[flagTool] || [];
  const currentProfileToolFlags = newProfileCliFlagsPerTool[profileFlagTool] || [];

  const toggleFlag = (flag: string) => {
    setCliFlagsPerTool(prev => {
      const cur = prev[flagTool] || [];
      const next = cur.includes(flag) ? cur.filter(f => f !== flag) : [...cur, flag];
      return { ...prev, [flagTool]: next };
    });
  };

  const addCustomFlag = () => {
    const f = customFlag.trim();
    if (f && !currentToolFlags.includes(f)) {
      setCliFlagsPerTool(prev => ({
        ...prev,
        [flagTool]: [...(prev[flagTool] || []), f],
      }));
      setCustomFlag('');
    }
  };

  const removeFlag = (flag: string) => {
    setCliFlagsPerTool(prev => ({
      ...prev,
      [flagTool]: (prev[flagTool] || []).filter(f => f !== flag),
    }));
  };

  const suggestedProviderVaultPath = suggestVaultPath(
    { mount: vaultConfig.mount },
    { identity: vaultStatus.identity },
    'git',
    newProviderName || newProviderType,
    'token',
  );

  const handleAddProvider = async () => {
    if (!newProviderName.trim() || !newProviderUrl.trim() || !newProviderToken.trim()) return;
    setNewProviderError(null);
    try {
      let tokenToStore = newProviderToken.trim();
      if (newProviderStoreInVault) {
        const ref = (newProviderVaultPath || suggestedProviderVaultPath).trim();
        try {
          await window.electronAPI.vault.writeSecret(ref, tokenToStore);
        } catch (err) {
          setNewProviderError(`Failed to write to Vault: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        tokenToStore = ref;
      }
      const provider = await window.electronAPI.gitProvider.create({
        name: newProviderName.trim(),
        type: newProviderType,
        baseUrl: newProviderUrl.trim(),
        organization: newProviderType === 'ado' ? newProviderOrg.trim() : undefined,
        token: tokenToStore,
      });
      setGitProviders(prev => [...prev, provider]);
      setShowAddProvider(false);
      setNewProviderName('');
      setNewProviderUrl('');
      setNewProviderOrg('');
      setNewProviderToken('');
      setNewProviderStoreInVault(false);
      setNewProviderVaultPath('');
      setNewProviderError(null);
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

  useEscapeKey(onClose, isOpen);

  if (!isOpen) return null;

  const toolDef = CLI_TOOL_REGISTRY[flagTool];
  const commonFlags = toolDef?.commonFlags || [];
  const commonFlagSet = new Set(commonFlags.map(f => f.flag));
  const extraFlags = currentToolFlags.filter(f => !commonFlagSet.has(f));

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog--wide" role="dialog" aria-modal="true">
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
                checked={hideTerminalCursor}
                onChange={e => setHideTerminalCursor(e.target.checked)}
              />
              Hide terminal cursor
            </label>
            <p className="form-hint">
              Suppress the xterm.js block cursor. Claude Code, Codex, and OpenCode draw
              their own input indicator, so the xterm cursor often reads as a redundant
              second cursor that bounces around during thinking animations.
              Leave off if you use plain shells, vim, or htop in Tether.
            </p>
          </div>

          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={enablePaneSplitting}
                onChange={e => setEnablePaneSplitting(e.target.checked)}
              />
              Enable pane splitting (experimental)
            </label>
            <p className="form-hint">
              Drag session headers to split the terminal area into multiple panes.
              Disable if you hit layout bugs &mdash; new sessions will replace the focused pane instead.
            </p>
            {enablePaneSplitting && (
              <div style={{ marginLeft: 22, marginTop: 10 }}>
                <label className="form-label" htmlFor="max-panes-select">
                  Maximum panes
                </label>
                <select
                  id="max-panes-select"
                  className="form-input"
                  value={maxPanes}
                  onChange={e => setMaxPanes(parseMaxPanes(e.target.value))}
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                </select>
                <p className="form-hint">
                  Panes use equal locked splits. Three-pane layouts are skipped.
                </p>
              </div>
            )}
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
                Resume previous conversations
              </label>
              <p className="form-hint">
                Reopen the same Claude Code or Codex CLI conversation each session was on, instead of starting fresh.
                Local environments only; SSH and Coder sessions always start fresh.
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
                Adds a small ↻ marker next to sessions that were resumed from a prior conversation.
              </p>

              <label className="form-radio-label" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={enableResumePicker}
                  onChange={e => setEnableResumePicker(e.target.checked)}
                />
                Enable "Resume previous conversation..." in the right-click menu
              </label>
              <p className="form-hint">
                Lets you manually pick an older Claude Code or Codex CLI conversation for a session&rsquo;s working directory.
              </p>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Default CLI Flags
            </label>
            <p className="form-hint" style={{ marginBottom: 8 }}>
              Applied to sessions using the selected CLI tool.
            </p>

            <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
              {FLAG_TOOLS.map(id => (
                <button
                  key={id}
                  className={`form-btn${flagTool === id ? ' form-btn--primary' : ''}`}
                  style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={() => { setFlagTool(id); setCustomFlag(''); }}
                >
                  {CLI_TOOL_REGISTRY[id].displayName}
                </button>
              ))}
            </div>

            {loaded && (
              <>
                {commonFlags.length > 0 ? commonFlags.map(({ flag, label }) => (
                  <label key={flag} className="form-radio-label" style={{ marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={currentToolFlags.includes(flag)}
                      onChange={() => toggleFlag(flag)}
                    />
                    <code className="cli-flag-code">{flag}</code>
                    <span className="form-hint" style={{ display: 'inline', marginLeft: 6 }}>{label}</span>
                  </label>
                )) : (
                  <p className="form-hint" style={{ marginBottom: 8 }}>No common flags defined for {toolDef?.displayName || flagTool}.</p>
                )}

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
                    setNewProfileCliFlagsPerTool(p.cliFlagsPerTool || (p.cliFlags.length > 0 ? { claude: p.cliFlags } : {}));
                    setProfileFlagTool('claude');
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
                  setNewProfileCliFlagsPerTool({});
                  setProfileFlagTool('claude');
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
                    <EnvVarEditor vars={newProfileEnvVars} onChange={setNewProfileEnvVars} cliTool={profileFlagTool} compact vaultEnabled={vaultStatus.enabled} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">CLI Flags</label>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                      {FLAG_TOOLS.map(id => (
                        <button
                          key={id}
                          className={`form-btn${profileFlagTool === id ? ' form-btn--primary' : ''}`}
                          style={{ fontSize: 12, padding: '3px 10px' }}
                          onClick={() => setProfileFlagTool(id)}
                        >
                          {CLI_TOOL_REGISTRY[id].displayName}
                        </button>
                      ))}
                    </div>
                    {currentProfileToolFlags.map(flag => (
                      <div key={flag} className="cli-flag-custom">
                        <code className="cli-flag-code">{flag}</code>
                        <button
                          className="env-editor-btn env-editor-btn--remove"
                          onClick={() => setNewProfileCliFlagsPerTool(prev => ({
                            ...prev,
                            [profileFlagTool]: (prev[profileFlagTool] || []).filter(f => f !== flag),
                          }))}
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
                            if (f && !currentProfileToolFlags.includes(f)) {
                              setNewProfileCliFlagsPerTool(prev => ({
                                ...prev,
                                [profileFlagTool]: [...(prev[profileFlagTool] || []), f],
                              }));
                              (e.target as HTMLInputElement).value = '';
                            }
                          }
                        }}
                      />
                      <button className="form-btn" onClick={e => {
                        const input = (e.target as HTMLElement).parentElement?.querySelector('input') as HTMLInputElement;
                        const f = input?.value?.trim();
                        if (f && !currentProfileToolFlags.includes(f)) {
                          setNewProfileCliFlagsPerTool(prev => ({
                            ...prev,
                            [profileFlagTool]: [...(prev[profileFlagTool] || []), f],
                          }));
                          if (input) input.value = '';
                        }
                      }}>Add</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="form-btn form-btn--primary" onClick={async () => {
                      if (!newProfileName.trim()) return;
                      const profileFlags = compactFlagsPerTool(newProfileCliFlagsPerTool);
                      const opts: CreateLaunchProfileOptions = {
                        name: newProfileName.trim(),
                        envVars: Object.keys(newProfileEnvVars).length > 0 ? newProfileEnvVars : undefined,
                        cliFlagsPerTool: Object.keys(profileFlags).length > 0 ? profileFlags : undefined,
                        cliFlags: profileFlags.claude,
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
                      setNewProfileCliFlagsPerTool({});
                      setProfileFlagTool('claude');
                    }}>
                      {editingProfileId ? 'Update' : 'Save'}
                    </button>
                    <button className="form-btn" onClick={() => {
                      setShowNewProfile(false);
                      setEditingProfileId(null);
                      setNewProfileName('');
                      setNewProfileEnvVars({});
                      setNewProfileCliFlagsPerTool({});
                      setProfileFlagTool('claude');
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
                  <input
                    type="password"
                    className="form-input"
                    value={newProviderToken}
                    onChange={e => setNewProviderToken(e.target.value)}
                    placeholder="ghp_... or PAT"
                    spellCheck={false}
                  />
                  {vaultStatus.enabled && vaultStatus.loggedIn && (
                    <>
                      <label className="form-radio-label" style={{ marginTop: 6, marginBottom: 4 }}>
                        <input
                          type="checkbox"
                          checked={newProviderStoreInVault}
                          onChange={e => setNewProviderStoreInVault(e.target.checked)}
                        />
                        Store in Vault
                      </label>
                      {newProviderStoreInVault && (
                        <>
                          <input
                            className="form-input"
                            value={newProviderVaultPath || suggestedProviderVaultPath}
                            onChange={e => setNewProviderVaultPath(e.target.value)}
                            placeholder={suggestedProviderVaultPath}
                            spellCheck={false}
                            style={{ marginTop: 4, fontSize: '0.85em' }}
                          />
                          <p className="form-hint" style={{ marginTop: 2 }}>
                            Token will be written to this Vault path on save.
                          </p>
                        </>
                      )}
                    </>
                  )}
                  {newProviderError && (
                    <p className="form-hint" style={{ marginTop: 4, color: 'var(--status-dead)' }}>
                      {newProviderError}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="form-btn form-btn--primary" onClick={handleAddProvider}
                    disabled={
                      !newProviderName.trim() ||
                      !newProviderUrl.trim() ||
                      !newProviderToken.trim()
                    }
                  >Save</button>
                  <button className="form-btn" onClick={() => {
                    setShowAddProvider(false);
                    setNewProviderName('');
                    setNewProviderUrl('');
                    setNewProviderOrg('');
                    setNewProviderToken('');
                    setNewProviderStoreInVault(false);
                    setNewProviderVaultPath('');
                    setNewProviderError(null);
                  }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* SSH Known Hosts */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              SSH Known Hosts
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Trusted SSH host fingerprints. Revoke an entry to force a fresh trust prompt
              on the next connection (or to recover after a "host key changed" error).
            </p>

            {knownHosts.length === 0 ? (
              <p className="form-hint" style={{ fontStyle: 'italic' }}>
                No trusted hosts yet. They appear here after you confirm a fingerprint
                on first connect.
              </p>
            ) : (
              <div className="provider-list known-hosts-list">
                {knownHosts.map(h => (
                  <div key={h.id} className="provider-row known-host-row">
                    <div className="known-host-details">
                      <span className="known-host-name">{h.hostKey}</span>
                      <span className="known-host-meta">
                        <span title={`SHA256:${h.keyHash}`} className="known-host-fingerprint">
                          SHA256:{h.keyHash.slice(0, 12)}...
                        </span>
                        <span>trusted {new Date(h.trustedAt).toLocaleDateString()}</span>
                      </span>
                    </div>
                    <button
                      className="env-editor-btn known-host-revoke"
                      title="Revoke this trusted host"
                      onClick={async () => {
                        await window.electronAPI.knownHosts.delete(h.id);
                        const fresh = await window.electronAPI.knownHosts.list().catch(() => [] as KnownHostInfo[]);
                        setKnownHosts(fresh);
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Updates */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Updates
            </label>
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={updateCheckEnabled}
                onChange={e => setUpdateCheckEnabled(e.target.checked)}
              />
              Check for updates on launch
            </label>
            <p className="form-hint">
              Automatically check GitHub for new Tether releases when the app starts.
            </p>
          </div>

          {/* Quota display */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Usage Quota
            </label>
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={quotaEnabled}
                onChange={e => setQuotaEnabled(e.target.checked)}
              />
              Show usage quota in sidebar
            </label>
            <p className="form-hint">
              Display Claude and Codex subscription usage (5-hour and 7-day windows) in the sidebar footer. Polls every 5 minutes.
            </p>
            <label className="form-radio-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={usageStripEnabled}
                onChange={e => setUsageStripEnabled(e.target.checked)}
              />
              Show per-session cost strip below terminal
            </label>
            <p className="form-hint">
              Display the active session's model, message count, and API-equivalent cost below each terminal pane. Updates live as Claude responds.
            </p>
            <label className="form-radio-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={globalUsageEnabled}
                onChange={e => setGlobalUsageEnabled(e.target.checked)}
              />
              Show global usage in sidebar
            </label>
            <p className="form-hint">
              Display today's total cost and a 7-day sparkline above the quota footer. Hover for a full breakdown including monthly and all-time totals.
            </p>
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

function parseMaxPanes(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4;
  if (parsed <= 1) return 1;
  if (parsed <= 2) return 2;
  return 4;
}
