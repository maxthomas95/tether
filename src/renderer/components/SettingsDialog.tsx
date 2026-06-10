import { useState, useEffect, useCallback, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { EnvVarEditor } from './EnvVarEditor';
import { MigrateToVaultDialog } from './MigrateToVaultDialog';
import { VaultPickerDialog } from './VaultPickerDialog';
import { themeList } from '../styles/themes';
import { suggestVaultPath, VAULT_REF_PREFIX } from '../utils/vault-path';

const isVaultRef = (v: string): boolean => v.startsWith(VAULT_REF_PREFIX);
import type { GitProviderInfo, GitProviderType, LaunchProfileInfo, CreateLaunchProfileOptions, VaultConfig, VaultStatus, CliToolId, KnownHostInfo, UsageExportFormat, NotificationPrefs, JobsStatus } from '../../shared/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../shared/types';
import { CLI_TOOL_REGISTRY } from '../../shared/cli-tools';
import { KeybindingsEditor } from './KeybindingsEditor';
import { HelpAnchor } from './HelpAnchor';
import type { KeybindingAction, Chord } from '../../shared/keybindings';
import type { TerminalCursorStyle } from '../hooks/useTerminalManager';

/** CLI tools that have definable flags (exclude 'custom' which has no known flags). */
const FLAG_TOOLS = (['claude', 'codex', 'copilot', 'opencode'] as const) satisfies readonly CliToolId[];
const CLI_TOOL_IDS = Object.keys(CLI_TOOL_REGISTRY) as CliToolId[];
const DEFAULT_PROVIDER_URLS: Partial<Record<GitProviderType, string>> = {
  github: 'https://api.github.com',
  ado: 'https://dev.azure.com',
};

function isCliToolId(value: string | null): value is CliToolId {
  return !!value && Object.prototype.hasOwnProperty.call(CLI_TOOL_REGISTRY, value);
}

function defaultProviderUrl(type: GitProviderType): string {
  return DEFAULT_PROVIDER_URLS[type] || '';
}

function formatKnownHostFingerprint(hash: string): string {
  if (/^[a-f0-9]{64}$/i.test(hash)) return `legacy-sha256-hex:${hash.toLowerCase()}`;
  return hash.startsWith('SHA256:') ? hash : `SHA256:${hash}`;
}

/**
 * Preset terminal font stacks. Empty value means "use the Tether default"
 * (Cascadia Code, defined in tokens.css). The dropdown stores the full CSS
 * font-family string so the value can flow straight to `--font-mono-terminal`
 * without translation.
 */
const TERMINAL_FONT_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Default (Cascadia Code)', value: '' },
  {
    label: 'JetBrains Mono',
    value: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  },
  {
    label: 'Fira Code',
    value: "'Fira Code', 'Cascadia Code', Consolas, monospace",
  },
  {
    label: 'Cascadia Code',
    value: "'Cascadia Code', Consolas, monospace",
  },
  {
    label: 'Consolas',
    value: "Consolas, 'Courier New', monospace",
  },
];

/**
 * Preset UI font stacks. Default = IBM Plex Sans (Tether's locked identity
 * face). Empty value resets to the tokens.css default. Atkinson Hyperlegible
 * and Inter are bundled via fontsource so they work without OS-side install.
 */
const UI_FONT_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Default (IBM Plex Sans)', value: '' },
  {
    label: 'Inter',
    value: "'Inter', 'IBM Plex Sans', -apple-system, 'Segoe UI', sans-serif",
  },
  {
    label: 'Atkinson Hyperlegible (high readability)',
    value: "'Atkinson Hyperlegible', 'IBM Plex Sans', -apple-system, 'Segoe UI', sans-serif",
  },
  {
    label: 'System default',
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
];

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

type SettingsSection = 'general' | 'terminal' | 'sessions' | 'notifications' | 'shortcuts' | 'integrations' | 'usage';

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'usage', label: 'Usage' },
];

/** Per-section docs deep-link target, used by the (?) help icon. */
const SECTION_HELP: Record<SettingsSection, { title: string; anchor: string }> = {
  general:       { title: 'General',       anchor: 'general' },
  terminal:      { title: 'Terminal',      anchor: 'terminal' },
  sessions:      { title: 'Sessions',      anchor: 'sessions' },
  notifications: { title: 'Notifications', anchor: 'notifications' },
  shortcuts:     { title: 'Shortcuts',     anchor: 'shortcuts' },
  integrations:  { title: 'Integrations',  anchor: 'integrations' },
  usage:         { title: 'Usage',         anchor: 'usage' },
};

function SectionHeader({ section }: Readonly<{ section: SettingsSection }>) {
  const meta = SECTION_HELP[section];
  return (
    <div className="settings-section-header">
      <span className="settings-section-header-title">{meta.title}</span>
      <HelpAnchor page="settings" anchor={meta.anchor} label={meta.title} />
    </div>
  );
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: string;
  onThemeChange: (name: string) => void;
  onResetSessionFontSizes: () => void;
  keybindings: Record<KeybindingAction, Chord | null>;
  onKeybindingChange: (action: KeybindingAction, chord: Chord | null) => void;
  onKeybindingsResetAll: () => void;
}

export function SettingsDialog({ isOpen, onClose, currentTheme, onThemeChange, onResetSessionFontSizes, keybindings, onKeybindingChange, onKeybindingsResetAll }: Readonly<SettingsDialogProps>) {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [cliFlagsPerTool, setCliFlagsPerTool] = useState<Partial<Record<CliToolId, string[]>>>({});
  const [flagTool, setFlagTool] = useState<CliToolId>('claude');
  const [customFlag, setCustomFlag] = useState('');
  const [defaultCliTool, setDefaultCliTool] = useState<CliToolId>('claude');
  const [defaultCustomCliBinary, setDefaultCustomCliBinary] = useState('');
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(true);
  const [resumePreviousChats, setResumePreviousChats] = useState(true);
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [enableResumePicker, setEnableResumePicker] = useState(true);
  const [enablePaneSplitting, setEnablePaneSplitting] = useState(false);
  const [maxPanes, setMaxPanes] = useState(4);
  const [allowHelm, setAllowHelm] = useState(false);
  const [cliHooksEnabled, setCliHooksEnabled] = useState(false);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);
  const [updateChannel, setUpdateChannel] = useState<'stable' | 'beta'>('stable');
  const [quotaEnabled, setQuotaEnabled] = useState(true);
  const [usageStripEnabled, setUsageStripEnabled] = useState(true);
  const [globalUsageEnabled, setGlobalUsageEnabled] = useState(true);
  const [cliToolBreakdownEnabled, setCliToolBreakdownEnabled] = useState(false);
  // J.O.B.S. office integration
  const [jobsEnabled, setJobsEnabled] = useState(true);
  const [jobsUrl, setJobsUrl] = useState('');
  const [jobsToken, setJobsToken] = useState('');
  const [jobsPath, setJobsPath] = useState('');
  const [jobsStatus, setJobsStatus] = useState<JobsStatus | null>(null);
  const [jobsTesting, setJobsTesting] = useState(false);
  const [exportBusy, setExportBusy] = useState<UsageExportFormat | null>(null);
  const [exportStatus, setExportStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [hideTerminalCursor, setHideTerminalCursor] = useState(true);
  const [terminalCursorStyle, setTerminalCursorStyle] = useState<TerminalCursorStyle>('block');
  const [terminalCursorBlink, setTerminalCursorBlink] = useState(true);
  const [terminalFontSize, setTerminalFontSize] = useState(14);
  const [terminalScrollback, setTerminalScrollback] = useState(10000);
  const [terminalFontFamily, setTerminalFontFamily] = useState<string>('');
  const [uiFontFamily, setUiFontFamily] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

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
  const [newProviderDefaultProject, setNewProviderDefaultProject] = useState('');
  const [newProviderToken, setNewProviderToken] = useState('');
  const [newProviderStoreInVault, setNewProviderStoreInVault] = useState(false);
  const [newProviderVaultPath, setNewProviderVaultPath] = useState('');
  const [newProviderError, setNewProviderError] = useState<string | null>(null);
  const [providerTestResult, setProviderTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});

  // Notification prefs state. Loaded once on dialog open via the notifications
  // IPC (single round trip, returns the full struct with defaults applied
  // server-side). Saved on dialog close along with the rest of the prefs.
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  // Vault state
  const [vaultConfig, setVaultConfig] = useState<VaultConfig>({
    enabled: false, addr: '', role: '', mount: 'secret', namespace: '',
  });
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>({ enabled: false, loggedIn: false });
  const [vaultLoginError, setVaultLoginError] = useState<string | null>(null);
  const [vaultLoggingIn, setVaultLoggingIn] = useState(false);
  const [showMigrateDialog, setShowMigrateDialog] = useState(false);
  const [showProviderVaultPicker, setShowProviderVaultPicker] = useState(false);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    Promise.all([
      window.electronAPI.config.getDefaultEnvVars?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('restoreOnLaunch')?.catch(() => null),
      window.electronAPI.config.getDefaultCliFlagsPerTool?.()?.catch(() => ({})),
      window.electronAPI.config.get?.('defaultCliTool')?.catch(() => null),
      window.electronAPI.config.get?.('defaultCustomCliBinary')?.catch(() => null),
      window.electronAPI.config.get?.('resumePreviousChats')?.catch(() => null),
      window.electronAPI.config.get?.('showResumeBadge')?.catch(() => null),
      window.electronAPI.config.get?.('enableResumePicker')?.catch(() => null),
      window.electronAPI.config.get?.('enablePaneSplitting')?.catch(() => null),
      window.electronAPI.config.get?.('maxPanes')?.catch(() => null),
      window.electronAPI.config.get?.('updateCheckEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('quotaEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('usageStripEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('globalUsageEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('cliToolBreakdownEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('hideTerminalCursor')?.catch(() => null),
      window.electronAPI.config.get?.('allowHelm')?.catch(() => null),
      window.electronAPI.config.get?.('terminalFontSize')?.catch(() => null),
      window.electronAPI.config.get?.('terminalFontFamily')?.catch(() => null),
      window.electronAPI.config.get?.('uiFontFamily')?.catch(() => null),
      window.electronAPI.config.get?.('terminalCursorStyle')?.catch(() => null),
      window.electronAPI.config.get?.('terminalCursorBlink')?.catch(() => null),
      window.electronAPI.config.get?.('terminalScrollback')?.catch(() => null),
      window.electronAPI.config.get?.('cliHooksEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('updateChannel')?.catch(() => null),
      window.electronAPI.config.get?.('jobsEnabled')?.catch(() => null),
      window.electronAPI.config.get?.('jobsUrl')?.catch(() => null),
      window.electronAPI.config.get?.('jobsToken')?.catch(() => null),
      window.electronAPI.config.get?.('jobsPath')?.catch(() => null),
    ]).then(([vars, restore, perToolFlags, cliToolSetting, customCliBinarySetting, resumeChats, badge, picker, splitting, maxPaneValue, updateCheck, quota, usageStrip, globalUsage, cliBreakdown, hideCursor, helm, fontSize, fontFamily, uiFont, cursorStyle, cursorBlink, scrollback, cliHooks, updateCh, jobsEnabledValue, jobsUrlValue, jobsTokenValue, jobsPathValue]) => {
      setEnvVars(vars || {});
      setRestoreOnLaunch(restore !== 'false');
      setCliFlagsPerTool(perToolFlags || {});
      setDefaultCliTool(isCliToolId(cliToolSetting) ? cliToolSetting : 'claude');
      setDefaultCustomCliBinary(typeof customCliBinarySetting === 'string' ? customCliBinarySetting.trim() : '');
      setResumePreviousChats(resumeChats !== 'false');
      setShowResumeBadge(badge === 'true');
      setEnableResumePicker(picker !== 'false');
      setEnablePaneSplitting(splitting === 'true');
      setMaxPanes(parseMaxPanes(maxPaneValue));
      setUpdateCheckEnabled(updateCheck !== 'false');
      setQuotaEnabled(quota !== 'false');
      setUsageStripEnabled(usageStrip !== 'false');
      setGlobalUsageEnabled(globalUsage !== 'false');
      setCliToolBreakdownEnabled(cliBreakdown === 'true');
      setHideTerminalCursor(hideCursor !== 'false');
      setAllowHelm(helm === 'true');
      const parsedFontSize = fontSize ? parseInt(fontSize, 10) : NaN;
      if (Number.isFinite(parsedFontSize) && parsedFontSize >= 8 && parsedFontSize <= 32) {
        setTerminalFontSize(parsedFontSize);
      }
      setTerminalFontFamily(typeof fontFamily === 'string' ? fontFamily.trim() : '');
      setUiFontFamily(typeof uiFont === 'string' ? uiFont.trim() : '');
      if (cursorStyle === 'block' || cursorStyle === 'underline' || cursorStyle === 'bar') {
        setTerminalCursorStyle(cursorStyle);
      }
      setTerminalCursorBlink(cursorBlink !== 'false');
      const parsedScrollback = scrollback ? parseInt(scrollback, 10) : NaN;
      if (Number.isFinite(parsedScrollback)) {
        setTerminalScrollback(Math.max(100, Math.min(100000, parsedScrollback)));
      }
      // cliHooksEnabled: default-off, opt-in. Only literal 'true' enables —
      // matches the read on the main side (`=== 'true'`). Missing key, empty
      // string, or any other value counts as disabled.
      setCliHooksEnabled(cliHooks === 'true');
      setUpdateChannel(updateCh === 'beta' ? 'beta' : 'stable');
      // jobsEnabled: default-on auto-detect; only the literal 'off' disables —
      // matches readJobsConfig() on the main side.
      setJobsEnabled(jobsEnabledValue !== 'off');
      setJobsUrl(jobsUrlValue || '');
      setJobsToken(jobsTokenValue || '');
      setJobsPath(jobsPathValue || '');
      setLoaded(true);
    });
    window.electronAPI.profile.list().then(setProfiles).catch(() => {});
    window.electronAPI.gitProvider.list().then(setGitProviders).catch(() => {});
    window.electronAPI.knownHosts.list().then(setKnownHosts).catch(() => {});
    window.electronAPI.vault.getConfig().then(setVaultConfig).catch(() => {});
    window.electronAPI.vault.status().then(setVaultStatus).catch(() => {});
    window.electronAPI.jobs.getStatus().then(setJobsStatus).catch(() => {});
    window.electronAPI.notifications.getPrefs()
      .then(p => { if (p) setNotificationPrefs(p); })
      .catch(() => { /* leave defaults */ });
  }, [isOpen]);

  // Live status updates from main
  useEffect(() => {
    const unsubVault = window.electronAPI.vault.onStatusChange(setVaultStatus);
    const unsubJobs = window.electronAPI.jobs.onStatusChange(setJobsStatus);
    return () => { unsubVault(); unsubJobs(); };
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
    await window.electronAPI.config.set?.('updateChannel', updateChannel);
    await window.electronAPI.config.set?.('quotaEnabled', quotaEnabled ? 'true' : 'false');
    await window.electronAPI.quota.setEnabled(quotaEnabled);
    await window.electronAPI.config.set?.('usageStripEnabled', usageStripEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('globalUsageEnabled', globalUsageEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('cliToolBreakdownEnabled', cliToolBreakdownEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('hideTerminalCursor', hideTerminalCursor ? 'true' : 'false');
    await window.electronAPI.config.set?.('terminalCursorStyle', terminalCursorStyle);
    await window.electronAPI.config.set?.('terminalCursorBlink', terminalCursorBlink ? 'true' : 'false');
    await window.electronAPI.config.set?.('allowHelm', allowHelm ? 'true' : 'false');
    // Write the literal string the read-side compares against. Default-off,
    // opt-in semantics live on the read side: only the exact string 'true'
    // enables CLI hooks. Missing key / any other value counts as disabled.
    await window.electronAPI.config.set?.('cliHooksEnabled', cliHooksEnabled ? 'true' : 'false');
    await window.electronAPI.config.set?.('terminalFontSize', String(terminalFontSize));
    await window.electronAPI.config.set?.('terminalScrollback', String(terminalScrollback));
    await window.electronAPI.config.set?.('terminalFontFamily', terminalFontFamily);
    await window.electronAPI.config.set?.('uiFontFamily', uiFontFamily);
    await window.electronAPI.config.set?.('defaultCliTool', defaultCliTool);
    await window.electronAPI.config.set?.('defaultCustomCliBinary', defaultCliTool === 'custom' ? defaultCustomCliBinary.trim() : '');
    window.dispatchEvent(new CustomEvent('tether:settings-changed'));
    for (const toolId of FLAG_TOOLS) {
      await window.electronAPI.config.setDefaultCliFlagsForTool?.(toolId, cliFlagsPerTool[toolId] || []);
    }
    await window.electronAPI.vault.setConfig(vaultConfig);
    await window.electronAPI.notifications.setPrefs(notificationPrefs);
    await window.electronAPI.config.set?.('jobsEnabled', jobsEnabled ? 'auto' : 'off');
    await window.electronAPI.config.set?.('jobsUrl', jobsUrl.trim());
    await window.electronAPI.config.set?.('jobsToken', jobsToken.trim());
    await window.electronAPI.config.set?.('jobsPath', jobsPath.trim());
    // Re-probe with the fresh config — fire-and-forget so save never blocks on a slow probe.
    window.electronAPI.jobs.refresh().catch(() => {});
    onClose();
  }, [envVars, restoreOnLaunch, resumePreviousChats, showResumeBadge, enableResumePicker, enablePaneSplitting, maxPanes, updateCheckEnabled, updateChannel, quotaEnabled, usageStripEnabled, globalUsageEnabled, cliToolBreakdownEnabled, hideTerminalCursor, terminalCursorStyle, terminalCursorBlink, allowHelm, cliHooksEnabled, terminalFontSize, terminalScrollback, terminalFontFamily, uiFontFamily, defaultCliTool, defaultCustomCliBinary, cliFlagsPerTool, vaultConfig, notificationPrefs, jobsEnabled, jobsUrl, jobsToken, jobsPath, onClose]);

  /**
   * Persist the jobs* keys and re-probe immediately so the user gets feedback
   * without closing the dialog. The keys are saved again on Save — writing
   * them here just makes "Test now" honest about what it's testing.
   */
  const handleJobsTest = async () => {
    setJobsTesting(true);
    try {
      await window.electronAPI.config.set?.('jobsEnabled', jobsEnabled ? 'auto' : 'off');
      await window.electronAPI.config.set?.('jobsUrl', jobsUrl.trim());
      await window.electronAPI.config.set?.('jobsToken', jobsToken.trim());
      await window.electronAPI.config.set?.('jobsPath', jobsPath.trim());
      const status = await window.electronAPI.jobs.refresh();
      setJobsStatus(status);
    } catch { /* status stays as-is */ } finally {
      setJobsTesting(false);
    }
  };

  const handleExportUsage = async (format: UsageExportFormat) => {
    setExportBusy(format);
    setExportStatus(null);
    try {
      const result = await window.electronAPI.usage.export(format);
      if (!result.ok) {
        // No filePath means the user cancelled the save dialog — leave status alone.
        if (result.error) {
          setExportStatus({ kind: 'error', message: `Export failed: ${result.error}` });
        }
        return;
      }
      const count = result.sessionCount ?? 0;
      const noun = count === 1 ? 'session' : 'sessions';
      setExportStatus({
        kind: 'ok',
        message: `Exported ${count} ${noun} to ${result.filePath}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExportStatus({ kind: 'error', message: `Export failed: ${message}` });
    } finally {
      setExportBusy(null);
    }
  };

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

  const newProviderEffectiveBaseUrl = newProviderUrl.trim() || defaultProviderUrl(newProviderType);
  const newProviderCanSave = !!newProviderName.trim()
    && !!newProviderEffectiveBaseUrl
    && !!newProviderToken.trim()
    && (newProviderType !== 'ado' || !!newProviderOrg.trim());

  const handleAddProvider = async () => {
    if (!newProviderCanSave) return;
    setNewProviderError(null);
    try {
      let tokenToStore = newProviderToken.trim();
      if (isVaultRef(tokenToStore)) {
        // Already a vault:// ref — store verbatim, no upload.
      } else if (newProviderStoreInVault) {
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
        baseUrl: newProviderEffectiveBaseUrl,
        organization: newProviderType === 'ado' ? newProviderOrg.trim() : undefined,
        defaultProject: newProviderType === 'ado' && newProviderDefaultProject.trim() ? newProviderDefaultProject.trim() : undefined,
        token: tokenToStore,
      });
      setGitProviders(prev => [...prev, provider]);
      setShowAddProvider(false);
      setNewProviderName('');
      setNewProviderUrl('');
      setNewProviderOrg('');
      setNewProviderDefaultProject('');
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);

  // Keyboard navigation for the section tablist (ArrowUp/ArrowDown move
  // between tabs and move focus, per the WAI-ARIA tablist pattern).
  const handleTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = SECTIONS.findIndex(s => s.id === activeSection);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = SECTIONS[(idx + delta + SECTIONS.length) % SECTIONS.length];
    setActiveSection(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  if (!isOpen) return null;

  const toolDef = CLI_TOOL_REGISTRY[flagTool];
  const commonFlags = toolDef?.commonFlags || [];
  const commonFlagSet = new Set(commonFlags.map(f => f.flag));
  const extraFlags = currentToolFlags.filter(f => !commonFlagSet.has(f));

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="dialog dialog--settings" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="dialog-header">
          <span>Settings</span>
          <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
        <div className="settings-layout">
          <aside className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={handleTablistKeyDown}>
            {SECTIONS.map(s => (
              <button
                key={s.id}
                id={`settings-tab-${s.id}`}
                role="tab"
                aria-selected={activeSection === s.id}
                aria-controls="settings-tabpanel"
                tabIndex={activeSection === s.id ? 0 : -1}
                className={`settings-nav-item${activeSection === s.id ? ' settings-nav-item--active' : ''}`}
                onClick={() => setActiveSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </aside>
          <div
            className="settings-content"
            role="tabpanel"
            id="settings-tabpanel"
            aria-labelledby={`settings-tab-${activeSection}`}
          >

          {activeSection === 'general' && (
            <>
          <SectionHeader section="general" />
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

            <label className="form-label" htmlFor="update-channel-select" style={{ marginTop: 12 }}>
              Update channel
            </label>
            <select
              id="update-channel-select"
              className="form-input"
              value={updateChannel}
              onChange={e => setUpdateChannel(e.target.value as 'stable' | 'beta')}
              disabled={!updateCheckEnabled}
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </select>
            <p className="form-hint">
              <strong>Stable</strong> only shows final releases. <strong>Beta</strong> also
              shows pre-release builds with the latest features and fixes.
            </p>
          </div>

          {/* Folders */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Folders
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="form-btn"
                onClick={() => { void window.electronAPI.diagnostics.openUserDataFolder(); }}
              >
                Open user data folder
              </button>
              <button
                className="form-btn"
                onClick={() => { void window.electronAPI.diagnostics.openLogsFolder(); }}
              >
                Open logs folder
              </button>
            </div>
            <p className="form-hint">
              <strong>User data</strong> holds <code>data.json</code> (environments, sessions, profiles, git
              providers, known hosts) and the cached LiteLLM pricing table.{' '}
              <strong>Logs</strong> holds Tether&rsquo;s runtime log files — handy when filing a bug or
              tailing what the app is doing.
            </p>
          </div>
            </>
          )}

          {activeSection === 'terminal' && (
            <>
          <SectionHeader section="terminal" />
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
              Turn this off if you use plain shells, vim, or htop in Tether.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="terminal-cursor-style-select">
              Cursor shape
            </label>
            <select
              id="terminal-cursor-style-select"
              className="form-input"
              value={terminalCursorStyle}
              onChange={e => setTerminalCursorStyle(e.target.value as TerminalCursorStyle)}
              disabled={hideTerminalCursor}
            >
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
            <p className="form-hint">
              Shape of the xterm.js cursor when visible. Has no effect while
              &ldquo;Hide terminal cursor&rdquo; is on.
            </p>
          </div>

          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={terminalCursorBlink}
                onChange={e => setTerminalCursorBlink(e.target.checked)}
                disabled={hideTerminalCursor}
              />
              Blink terminal cursor
            </label>
            <p className="form-hint">
              Blink the xterm.js cursor when visible. Has no effect while
              &ldquo;Hide terminal cursor&rdquo; is on.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="terminal-font-size-input">
              Default terminal font size
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id="terminal-font-size-input"
                className="form-input"
                type="number"
                min={8}
                max={32}
                step={1}
                value={terminalFontSize}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setTerminalFontSize(Math.max(8, Math.min(32, n)));
                }}
                style={{ width: 80 }}
              />
              <button
                type="button"
                className="form-btn"
                onClick={onResetSessionFontSizes}
              >
                Reset all session font sizes
              </button>
            </div>
            <p className="form-hint">
              Base size in pixels (8&ndash;32). Ctrl+wheel on a terminal pane sets a
              per-session override that lasts for the session&rsquo;s lifetime; the reset
              button clears all overrides so panes pick up the default again.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="terminal-scrollback-input">
              Terminal scrollback buffer
            </label>
            <input
              id="terminal-scrollback-input"
              className="form-input"
              type="number"
              min={100}
              max={100000}
              step={100}
              value={terminalScrollback}
              onChange={e => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setTerminalScrollback(Math.max(100, Math.min(100000, n)));
              }}
              style={{ width: 120 }}
            />
            <p className="form-hint">
              Lines of scrollback kept per pane (100&ndash;100,000; default 10,000).
              xterm.js&rsquo;s built-in default of 1,000 is exhausted in seconds by
              agentic CLI output. Larger values keep more history but cost more
              memory per pane; changes apply immediately to existing panes.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="terminal-font-family-select">
              Terminal font family
            </label>
            <select
              id="terminal-font-family-select"
              className="form-input"
              value={terminalFontFamily}
              onChange={e => setTerminalFontFamily(e.target.value)}
            >
              {TERMINAL_FONT_PRESETS.map(preset => (
                <option key={preset.label} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="form-hint">
              Applies to xterm.js panes only. Tether&rsquo;s own UI keeps IBM Plex
              Sans / JetBrains Mono regardless of this choice. Fonts other than
              the default rely on the OS having them installed; falls back to
              Cascadia Code or Consolas if missing.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ui-font-family-select">
              UI font family
            </label>
            <select
              id="ui-font-family-select"
              className="form-input"
              value={uiFontFamily}
              onChange={e => setUiFontFamily(e.target.value)}
            >
              {UI_FONT_PRESETS.map(preset => (
                <option key={preset.label} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="form-hint">
              Affects sidebar, dialogs, and menus. Spacing tokens are tuned for
              IBM Plex Sans; alternates may pack slightly tighter or looser.
              Inter and Atkinson Hyperlegible are bundled.
            </p>
          </div>
            </>
          )}

          {activeSection === 'sessions' && (
            <>
          <SectionHeader section="sessions" />
          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={allowHelm}
                onChange={e => setAllowHelm(e.target.checked)}
              />
              <span>Allow Helm</span>
              <span className="settings-tag settings-tag--experimental">Experimental</span>
            </label>
            <p className="form-hint">
              Unlocks the per-session &ldquo;Enable Helm&rdquo; toggle, which lets a designated
              Claude session dispatch pre-briefed child sessions via the <code>tether-helm</code> MCP.
              Leave off unless you&rsquo;re specifically using this — it changes Tether&rsquo;s surface area.
            </p>
          </div>

          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={cliHooksEnabled}
                onChange={e => setCliHooksEnabled(e.target.checked)}
              />
              <span>Use CLI hooks for smarter status detection</span>
            </label>
            <p className="form-hint">
              When on, Tether installs an additive entry in your
              <code> ~/.claude/settings.json </code> and
              <code> ~/.codex/config.toml </code>
              so Claude/Codex tell us directly when a turn finishes or input is needed.
              When off, Tether falls back to passive output observation only.
              Takes effect on the next Tether launch.
            </p>
          </div>

          <div className="form-group">
            <label className="form-radio-label">
              <input
                type="checkbox"
                checked={enablePaneSplitting}
                onChange={e => setEnablePaneSplitting(e.target.checked)}
              />
              <span>Enable pane splitting</span>
              <span className="settings-tag settings-tag--experimental">Experimental</span>
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

          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Default CLI Tool
            </label>
            <p className="form-hint" style={{ marginBottom: 8 }}>
              Preselected when you open the New Session dialog. You can still change it per session.
            </p>
            <select
              className="form-input"
              value={defaultCliTool}
              onChange={e => setDefaultCliTool(e.target.value as CliToolId)}
            >
              {CLI_TOOL_IDS.map(id => (
                <option key={id} value={id}>{CLI_TOOL_REGISTRY[id].displayName}</option>
              ))}
            </select>
            {defaultCliTool === 'custom' && (
              <input
                className="form-input"
                value={defaultCustomCliBinary}
                onChange={e => setDefaultCustomCliBinary(e.target.value)}
                placeholder="my-agent-cli"
                spellCheck={false}
                style={{ marginTop: 8 }}
              />
            )}
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
            </>
          )}

          {activeSection === 'notifications' && (
            <>
            <SectionHeader section="notifications" />
            <div className="form-group">
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Tether can post an OS desktop notification when a session changes state, so you can
                step away from the window and still know when it needs attention. Mute an individual
                session from its right-click menu in the sidebar.
              </p>

              <label className="form-radio-label">
                <input
                  type="checkbox"
                  checked={notificationPrefs.onWaiting}
                  onChange={e => setNotificationPrefs(p => ({ ...p, onWaiting: e.target.checked }))}
                />
                Notify when a session is waiting for input
              </label>
              <p className="form-hint">
                Fires when the CLI finishes its turn or hits a permission prompt — the moment the
                sidebar dot goes amber.
              </p>

              <label className="form-radio-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={notificationPrefs.onIdle}
                  onChange={e => setNotificationPrefs(p => ({ ...p, onIdle: e.target.checked }))}
                />
                Notify when a session goes idle
              </label>
              <p className="form-hint">
                Fires after the session has been silent past the idle timeout.
              </p>

              <label className="form-radio-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={notificationPrefs.onError}
                  onChange={e => setNotificationPrefs(p => ({ ...p, onError: e.target.checked }))}
                />
                Notify when a session exits unexpectedly
              </label>
              <p className="form-hint">
                Fires on non-zero exit codes. Clean exits (you closed the session) stay quiet.
              </p>

              <label className="form-radio-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={notificationPrefs.onBell}
                  onChange={e => setNotificationPrefs(p => ({ ...p, onBell: e.target.checked }))}
                />
                Notify on terminal bell
              </label>
              <p className="form-hint">
                Fires when the CLI emits an ASCII BEL (<code>\x07</code>). Coalesced so a noisy
                session won&rsquo;t spam your notification center.
              </p>

              <label className="form-radio-label" style={{ marginTop: 14 }}>
                <input
                  type="checkbox"
                  checked={notificationPrefs.suppressWhenFocused}
                  onChange={e => setNotificationPrefs(p => ({ ...p, suppressWhenFocused: e.target.checked }))}
                />
                Suppress notifications while Tether is focused
              </label>
              <p className="form-hint">
                If you&rsquo;re already looking at Tether, the OS toast is redundant. Turn this off if
                you want the alert even when the window has focus.
              </p>
            </div>
            </>
          )}

          {activeSection === 'shortcuts' && (
            <>
            <SectionHeader section="shortcuts" />
            <div className="form-group">
              <div className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
                Keyboard Shortcuts
              </div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Click <strong>Record</strong> on a row to capture a new chord, then press the key combination. Esc cancels. Reserved chords (⚠) still bind but may conflict with terminal or OS behavior.
              </p>
              <KeybindingsEditor bindings={keybindings} onChange={onKeybindingChange} />
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="form-btn" onClick={onKeybindingsResetAll} type="button">
                  Reset all to defaults
                </button>
              </div>
            </div>
            </>
          )}

          {activeSection === 'integrations' && (
            <>
          <SectionHeader section="integrations" />
          {/* Git Providers */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              Git Providers
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Connect to GitHub, Azure DevOps, or Gitea to browse and clone repos from the New Session dialog.
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
                    <option value="github">GitHub</option>
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
                    placeholder={
                      newProviderType === 'gitea' ? 'https://gitea.example.com'
                      : `Default: ${defaultProviderUrl(newProviderType)}`
                    }
                  />
                  {newProviderType === 'github' && (
                    <p className="form-hint" style={{ marginTop: 4 }}>
                      Leave blank for github.com, or use your GHE URL like https://github.example.com/api/v3.
                    </p>
                  )}
                </div>
                {newProviderType === 'ado' && (
                  <>
                    <div className="form-group">
                      <label className="form-label">Organization</label>
                      <input
                        className="form-input"
                        value={newProviderOrg}
                        onChange={e => setNewProviderOrg(e.target.value)}
                        placeholder="my-org"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="provider-default-project">Default project (optional)</label>
                      <input
                        id="provider-default-project"
                        className="form-input"
                        value={newProviderDefaultProject}
                        onChange={e => setNewProviderDefaultProject(e.target.value)}
                        placeholder="my-project"
                      />
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        Pre-fills the project picker when creating a new repo on this provider.
                      </p>
                    </div>
                  </>
                )}
                <div className="form-group">
                  <label className="form-label">Personal Access Token</label>
                  <div className="form-row">
                    <input
                      type={isVaultRef(newProviderToken) ? 'text' : 'password'}
                      className="form-input"
                      value={newProviderToken}
                      onChange={e => setNewProviderToken(e.target.value)}
                      placeholder="ghp_... or PAT"
                      spellCheck={false}
                    />
                    {vaultStatus.enabled && vaultStatus.loggedIn && !isVaultRef(newProviderToken) && (
                      <button
                        type="button"
                        className="form-btn"
                        onClick={() => setShowProviderVaultPicker(true)}
                        title="Pick an existing token from Vault"
                      >
                        Browse Vault
                      </button>
                    )}
                    {isVaultRef(newProviderToken) && (
                      <button
                        type="button"
                        className="form-btn"
                        onClick={() => setNewProviderToken('')}
                        title="Clear the Vault reference"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {newProviderType === 'github' && (
                    <p className="form-hint" style={{ marginTop: 4 }}>
                      Classic PAT: <code>repo</code> + <code>read:org</code>. Fine-grained PAT: Contents (Read).
                    </p>
                  )}
                  {newProviderType === 'gitea' && (
                    <p className="form-hint" style={{ marginTop: 4 }}>
                      Scoped token needs <code>read:user</code> + <code>read:repository</code> to browse, plus <code>write:user</code> + <code>write:repository</code> to create new repos.
                    </p>
                  )}
                  {newProviderType === 'ado' && (
                    <p className="form-hint" style={{ marginTop: 4 }}>
                      PAT needs <strong>Code (Read)</strong> to browse, or <strong>Code (Read &amp; write)</strong> to create new repos. <strong>Project and Team (Read)</strong> is also required for the project picker.
                    </p>
                  )}
                  {isVaultRef(newProviderToken) && (
                    <p className="form-hint" style={{ marginTop: 4, color: 'var(--status-running)' }}>
                      Resolved from Vault on each request.
                    </p>
                  )}
                  {vaultStatus.enabled && vaultStatus.loggedIn && !isVaultRef(newProviderToken) && (
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
                    disabled={!newProviderCanSave}
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
                        <span title={formatKnownHostFingerprint(h.keyHash)} className="known-host-fingerprint">
                          {formatKnownHostFingerprint(h.keyHash).slice(0, 19)}...
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

          {/* J.O.B.S. office */}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
              J.O.B.S. Office
            </label>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Pixel-art office that visualizes Claude Code agent activity (a separate
              self-hosted server). Tether auto-detects a running instance, adds an
              Office view, and narrates SSH/Coder sessions into it — local sessions
              are seen by JOBS directly via its own transcript watcher.
            </p>

            <div className="form-group">
              <label className="form-radio-label">
                <input
                  type="checkbox"
                  checked={jobsEnabled}
                  onChange={e => setJobsEnabled(e.target.checked)}
                />
                Enable J.O.B.S. integration (auto-detect)
              </label>
            </div>

            {jobsEnabled && (
              <>
                <div className="form-group">
                  <label className="form-label">Server URL</label>
                  <input
                    className="form-input"
                    value={jobsUrl}
                    onChange={e => setJobsUrl(e.target.value)}
                    placeholder="http://localhost:8780"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Token (optional)</label>
                  <input
                    className="form-input"
                    type="password"
                    value={jobsToken}
                    onChange={e => setJobsToken(e.target.value)}
                    placeholder=""
                    spellCheck={false}
                  />
                  <p className="form-hint">
                    Sent as Bearer auth on webhook posts. Also injected as
                    JOBS_TOKEN/WEBHOOK_TOKEN when Tether launches the server itself.
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Local JOBS folder (optional)</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="form-input"
                      value={jobsPath}
                      onChange={e => setJobsPath(e.target.value)}
                      placeholder="C:\repo\jobs"
                      spellCheck={false}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="form-btn"
                      onClick={async () => {
                        const dir = await window.electronAPI.dialog.openDirectory();
                        if (dir) setJobsPath(dir);
                      }}
                    >
                      Browse…
                    </button>
                  </div>
                  <p className="form-hint">
                    When set and nothing answers the probe, Tether launches the built
                    server (dist-server) from this folder and stops it again on quit.
                    Leave blank if you run JOBS yourself (e.g. Docker).
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Status</label>
                  <div style={{ marginTop: 4 }}>
                    {jobsStatus?.detected ? (
                      <span className="form-hint" style={{ color: 'var(--status-running)' }}>
                        {'●'} Detected
                        {jobsStatus.version ? ` v${jobsStatus.version}` : ''}
                        {jobsStatus.managed ? ' (launched by Tether)' : ''}
                      </span>
                    ) : (
                      <span className="form-hint" style={{ color: 'var(--text-muted)' }}>
                        {'○'} Not detected
                      </span>
                    )}
                    {jobsStatus?.error && (
                      <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 6 }}>
                        {jobsStatus.error}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="form-btn" onClick={handleJobsTest} disabled={jobsTesting}>
                      {jobsTesting ? 'Probing…' : 'Test now'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
            </>
          )}

          {activeSection === 'usage' && (
            <>
          <SectionHeader section="usage" />
          {/* Quota display */}
          <div className="form-group">
            <label className="form-label settings-section-label" style={{ fontSize: 14, marginBottom: 8 }}>
              <span>Usage Quota</span>
              <span className="settings-tag settings-tag--experimental">Experimental</span>
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
            <label className="form-radio-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={cliToolBreakdownEnabled}
                onChange={e => setCliToolBreakdownEnabled(e.target.checked)}
                disabled={!globalUsageEnabled}
              />
              Show per-CLI tool breakdown in usage footer
            </label>
            <p className="form-hint">
              Splits today's spend by CLI tool (Claude, Codex, etc.) and adds a per-tool section to the footer tooltip.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label settings-section-label" style={{ fontSize: 14, marginBottom: 8 }}>
              <span>Export usage history</span>
            </label>
            <p className="form-hint" style={{ marginTop: 0 }}>
              Save every tracked session's tokens and API-equivalent cost to a file. CSV is one row per session for spreadsheets; JSON includes the full per-model breakdown and daily rollups.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="form-btn"
                disabled={exportBusy !== null}
                onClick={() => handleExportUsage('csv')}
              >
                {exportBusy === 'csv' ? 'Exporting…' : 'Export as CSV…'}
              </button>
              <button
                type="button"
                className="form-btn"
                disabled={exportBusy !== null}
                onClick={() => handleExportUsage('json')}
              >
                {exportBusy === 'json' ? 'Exporting…' : 'Export as JSON…'}
              </button>
            </div>
            {exportStatus && (
              <p
                className="form-hint"
                style={{
                  marginTop: 8,
                  color: exportStatus.kind === 'error' ? 'var(--status-dead)' : 'var(--status-running)',
                }}
              >
                {exportStatus.message}
              </p>
            )}
          </div>
            </>
          )}

          </div>
        </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button className="form-btn form-btn--primary" onClick={handleSave}>Save</button>
        </div>
      </div>
      <MigrateToVaultDialog isOpen={showMigrateDialog} onClose={() => setShowMigrateDialog(false)} />
      <VaultPickerDialog
        isOpen={showProviderVaultPicker}
        onClose={() => setShowProviderVaultPicker(false)}
        onSelect={ref => {
          setNewProviderToken(ref);
          setNewProviderStoreInVault(false);
          setShowProviderVaultPicker(false);
        }}
      />
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
