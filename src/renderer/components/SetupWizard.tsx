import { useState, useCallback, useEffect, useMemo } from 'react';
import logoSrc from '../assets/logo.png';
import { MigrateToVaultDialog } from './MigrateToVaultDialog';
import { VaultPickerDialog } from './VaultPickerDialog';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { suggestVaultPath, VAULT_REF_PREFIX } from '../utils/vault-path';
import { CLI_TOOL_REGISTRY } from '../../shared/cli-tools';
import type {
  CliToolId,
  EnvironmentInfo,
  GitProviderInfo,
  GitProviderType,
  VaultConfig,
  VaultStatus,
} from '../../shared/types';

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (opts?: { openNewSession?: boolean }) => void;
  onEnvironmentCreated?: (environment: EnvironmentInfo) => void;
}

type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;
type RemoteEnvironmentChoice = 'none' | 'ssh' | 'coder';
type SshAuthMethod = 'agent' | 'key' | 'password';
type VaultPickerTarget = 'sshPassword' | 'providerToken';

const TOTAL_STEPS = 6;
const CLI_TOOL_IDS = Object.keys(CLI_TOOL_REGISTRY) as CliToolId[];
const KNOWN_CLI_TOOL_IDS = CLI_TOOL_IDS.filter(id => id !== 'custom');
const DEFAULT_PROVIDER_URLS: Partial<Record<GitProviderType, string>> = {
  github: 'https://api.github.com',
  ado: 'https://dev.azure.com',
};
const EMPTY_VAULT_STATUS: VaultStatus = { enabled: false, loggedIn: false };

interface Summary {
  reposRoot: string | null;
  defaultCliTool: CliToolId;
  customCliBinary: string | null;
  environmentName: string | null;
  vaultEnabled: boolean;
  vaultLoggedIn: boolean;
  gitProviderName: string | null;
}

const isVaultRef = (value: string): boolean => value.startsWith(VAULT_REF_PREFIX);

function defaultProviderUrl(type: GitProviderType): string {
  return DEFAULT_PROVIDER_URLS[type] || '';
}

function isCliToolId(value: string | null): value is CliToolId {
  return !!value && Object.prototype.hasOwnProperty.call(CLI_TOOL_REGISTRY, value);
}

function stepTitle(step: WizardStep): string {
  switch (step) {
    case 0: return 'Welcome';
    case 1: return 'Projects';
    case 2: return 'Vault';
    case 3: return 'Environment & CLI';
    case 4: return 'Git Provider';
    case 5: return 'Ready';
  }
}

export function SetupWizard({ isOpen, onClose, onComplete, onEnvironmentCreated }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(0);
  const [reposRoot, setReposRoot] = useState('');

  const [defaultCliTool, setDefaultCliTool] = useState<CliToolId>('claude');
  const [customCliBinary, setCustomCliBinary] = useState('');
  const [cliInstallStatus, setCliInstallStatus] = useState<Partial<Record<CliToolId, boolean>>>({});
  const [cliStatusLoaded, setCliStatusLoaded] = useState(false);

  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [remoteEnvChoice, setRemoteEnvChoice] = useState<RemoteEnvironmentChoice>('none');
  const [remoteEnvName, setRemoteEnvName] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUsername, setSshUsername] = useState('');
  const [sshDefaultDir, setSshDefaultDir] = useState('~');
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>('agent');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [sshStoreInVault, setSshStoreInVault] = useState(false);
  const [sshVaultPath, setSshVaultPath] = useState('');
  const [sshUseSudo, setSshUseSudo] = useState(false);
  const [coderBinary, setCoderBinary] = useState('coder');
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [savingEnvironment, setSavingEnvironment] = useState(false);

  const [vaultEnabled, setVaultEnabled] = useState(false);
  const [vaultAddr, setVaultAddr] = useState('');
  const [vaultRole, setVaultRole] = useState('');
  const [vaultMount, setVaultMount] = useState('secret');
  const [vaultNamespace, setVaultNamespace] = useState('');
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>(EMPTY_VAULT_STATUS);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultLoggingIn, setVaultLoggingIn] = useState(false);
  const [showMigrateDialog, setShowMigrateDialog] = useState(false);

  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);
  const [providerType, setProviderType] = useState<GitProviderType>('github');
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerOrg, setProviderOrg] = useState('');
  const [providerDefaultProject, setProviderDefaultProject] = useState('');
  const [providerToken, setProviderToken] = useState('');
  const [providerStoreInVault, setProviderStoreInVault] = useState(false);
  const [providerVaultPath, setProviderVaultPath] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerAdded, setProviderAdded] = useState<string | null>(null);
  const [providerTestResult, setProviderTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);

  const [vaultPickerTarget, setVaultPickerTarget] = useState<VaultPickerTarget | null>(null);

  const [summary, setSummary] = useState<Summary>({
    reposRoot: null,
    defaultCliTool: 'claude',
    customCliBinary: null,
    environmentName: null,
    vaultEnabled: false,
    vaultLoggedIn: false,
    gitProviderName: null,
  });

  const resetForm = useCallback(() => {
    setStep(0);
    setReposRoot('');
    setDefaultCliTool('claude');
    setCustomCliBinary('');
    setRemoteEnvChoice('none');
    setRemoteEnvName('');
    setSshHost('');
    setSshPort('22');
    setSshUsername('');
    setSshDefaultDir('~');
    setSshAuthMethod('agent');
    setSshKeyPath('');
    setSshPassword('');
    setSshStoreInVault(false);
    setSshVaultPath('');
    setSshUseSudo(false);
    setCoderBinary('coder');
    setEnvironmentError(null);
    setSavingEnvironment(false);
    setVaultEnabled(false);
    setVaultAddr('');
    setVaultRole('');
    setVaultMount('secret');
    setVaultNamespace('');
    setVaultStatus(EMPTY_VAULT_STATUS);
    setVaultError(null);
    setVaultLoggingIn(false);
    setProviderType('github');
    setProviderName('');
    setProviderUrl('');
    setProviderOrg('');
    setProviderDefaultProject('');
    setProviderToken('');
    setProviderStoreInVault(false);
    setProviderVaultPath('');
    setProviderError(null);
    setProviderAdded(null);
    setProviderTestResult(null);
    setSavingProvider(false);
    setTestingProvider(false);
    setVaultPickerTarget(null);
    setSummary({
      reposRoot: null,
      defaultCliTool: 'claude',
      customCliBinary: null,
      environmentName: null,
      vaultEnabled: false,
      vaultLoggedIn: false,
      gitProviderName: null,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    Promise.all([
      window.electronAPI.config.get('reposRoot').catch(() => null),
      window.electronAPI.config.get('defaultCliTool').catch(() => null),
      window.electronAPI.config.get('defaultCustomCliBinary').catch(() => null),
      window.electronAPI.vault.getConfig().catch((): VaultConfig => ({
        enabled: false,
        addr: '',
        role: '',
        mount: 'secret',
        namespace: '',
      })),
      window.electronAPI.vault.status().catch(() => EMPTY_VAULT_STATUS),
      window.electronAPI.gitProvider.list().catch(() => [] as GitProviderInfo[]),
      window.electronAPI.environment.list().catch(() => [] as EnvironmentInfo[]),
    ]).then(([root, tool, customBinary, vaultConfig, status, providers, envs]) => {
      if (cancelled) return;
      const parsedTool = isCliToolId(tool) ? tool : 'claude';
      setReposRoot(root || '');
      setDefaultCliTool(parsedTool);
      setCustomCliBinary(customBinary || '');
      setVaultEnabled(!!vaultConfig.enabled);
      setVaultAddr(vaultConfig.addr || '');
      setVaultRole(vaultConfig.role || '');
      setVaultMount(vaultConfig.mount || 'secret');
      setVaultNamespace(vaultConfig.namespace || '');
      setVaultStatus(status);
      setGitProviders(providers);
      setEnvironments(envs);
      const remoteEnvCount = envs.filter(env => env.type !== 'local').length;
      setSummary(prev => ({
        ...prev,
        reposRoot: root || null,
        defaultCliTool: parsedTool,
        customCliBinary: parsedTool === 'custom' ? customBinary || null : null,
        environmentName: remoteEnvCount > 0 ? `${remoteEnvCount} remote configured` : null,
        vaultEnabled: !!vaultConfig.enabled,
        vaultLoggedIn: status.loggedIn,
        gitProviderName: providers.length > 0 ? `${providers.length} configured` : null,
      }));
    });

    const unsub = window.electronAPI.vault.onStatusChange(status => {
      setVaultStatus(status);
      setSummary(prev => ({
        ...prev,
        vaultLoggedIn: status.loggedIn,
      }));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCliStatusLoaded(false);

    Promise.all(KNOWN_CLI_TOOL_IDS.map(async (id) => {
      const found = await window.electronAPI.shell.commandExists(CLI_TOOL_REGISTRY[id].binaryName)
        .catch(() => false);
      return [id, found] as const;
    })).then(results => {
      if (cancelled) return;
      const next: Partial<Record<CliToolId, boolean>> = {};
      for (const [id, found] of results) next[id] = found;
      setCliInstallStatus(next);
      setCliStatusLoaded(true);
    });

    return () => { cancelled = true; };
  }, [isOpen]);

  const handleClose = useCallback(() => {
    onClose();
    resetForm();
  }, [onClose, resetForm]);

  const handleComplete = useCallback((openNewSession: boolean) => {
    onComplete({ openNewSession });
    resetForm();
  }, [onComplete, resetForm]);

  const handleBrowse = useCallback(async () => {
    const dir = await window.electronAPI.dialog.openDirectory();
    if (dir) setReposRoot(dir);
  }, []);

  const handleReposNext = useCallback(async () => {
    const trimmed = reposRoot.trim();
    if (trimmed) {
      await window.electronAPI.config.set('reposRoot', trimmed);
      setSummary(prev => ({ ...prev, reposRoot: trimmed }));
    }
    setStep(2);
  }, [reposRoot]);

  const vaultConfig = useMemo<VaultConfig>(() => ({
    enabled: vaultEnabled,
    addr: vaultAddr.trim(),
    role: vaultRole.trim(),
    mount: vaultMount.trim() || 'secret',
    namespace: vaultNamespace.trim(),
  }), [vaultEnabled, vaultAddr, vaultRole, vaultMount, vaultNamespace]);

  const vaultReadyToSave = !vaultEnabled || (!!vaultAddr.trim() && !!vaultRole.trim());
  const vaultAvailableForSecrets = vaultStatus.enabled && vaultStatus.loggedIn;

  const handleVaultSave = useCallback(async () => {
    if (!vaultReadyToSave) {
      setVaultError('Vault address and OIDC role are required to enable Vault.');
      return;
    }
    setVaultError(null);
    try {
      await window.electronAPI.vault.setConfig(vaultConfig);
      setSummary(prev => ({
        ...prev,
        vaultEnabled,
        vaultLoggedIn: vaultStatus.loggedIn,
      }));
      setStep(3);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : String(err));
    }
  }, [vaultConfig, vaultEnabled, vaultReadyToSave, vaultStatus.loggedIn]);

  const handleVaultLogin = useCallback(async () => {
    if (!vaultReadyToSave || !vaultEnabled) {
      setVaultError('Enter the Vault address and OIDC role before logging in.');
      return;
    }
    setVaultLoggingIn(true);
    setVaultError(null);
    try {
      await window.electronAPI.vault.setConfig(vaultConfig);
      const status = await window.electronAPI.vault.login();
      setVaultStatus(status);
      setSummary(prev => ({
        ...prev,
        vaultEnabled: true,
        vaultLoggedIn: status.loggedIn,
      }));
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultLoggingIn(false);
    }
  }, [vaultConfig, vaultEnabled, vaultReadyToSave]);

  const suggestedSshVaultPath = suggestVaultPath(
    { mount: vaultMount || 'secret' },
    { identity: vaultStatus.identity },
    'ssh',
    remoteEnvName || sshHost || 'host',
    'password',
  );

  const suggestedProviderVaultPath = suggestVaultPath(
    { mount: vaultMount || 'secret' },
    { identity: vaultStatus.identity },
    'git',
    providerName || providerType,
    'token',
  );

  const selectedCliStatus = defaultCliTool !== 'custom' ? cliInstallStatus[defaultCliTool] : undefined;
  const remoteEnvDisplayName = remoteEnvName.trim()
    || (remoteEnvChoice === 'ssh' ? sshHost.trim() || 'SSH' : 'Coder');

  const environmentCanContinue = (() => {
    if (defaultCliTool === 'custom' && !customCliBinary.trim()) return false;
    if (remoteEnvChoice === 'none') return true;
    if (remoteEnvChoice === 'coder') return true;
    if (!sshHost.trim()) return false;
    if (sshAuthMethod === 'key') return !!sshKeyPath.trim();
    if (sshAuthMethod === 'password') return !!sshPassword.trim();
    return true;
  })();

  const handleEnvironmentAndCliNext = useCallback(async () => {
    if (!environmentCanContinue) return;
    setEnvironmentError(null);
    setSavingEnvironment(true);
    try {
      await window.electronAPI.config.set('defaultCliTool', defaultCliTool);
      await window.electronAPI.config.set(
        'defaultCustomCliBinary',
        defaultCliTool === 'custom' ? customCliBinary.trim() : '',
      );

      let environmentName: string | null = null;
      if (remoteEnvChoice === 'ssh') {
        let passwordToStore = sshPassword.trim();
        if (sshAuthMethod === 'password' && passwordToStore && !isVaultRef(passwordToStore) && sshStoreInVault) {
          if (!vaultAvailableForSecrets) {
            setEnvironmentError('Log in to Vault before storing the SSH password there.');
            return;
          }
          const ref = (sshVaultPath || suggestedSshVaultPath).trim();
          await window.electronAPI.vault.writeSecret(ref, passwordToStore);
          passwordToStore = ref;
        }

        const config: Record<string, unknown> = {
          host: sshHost.trim(),
          port: parseInt(sshPort, 10) || 22,
          username: sshUsername.trim() || 'root',
          defaultDir: sshDefaultDir.trim() || '~',
        };
        if (sshAuthMethod === 'agent') config.useAgent = true;
        if (sshAuthMethod === 'key') config.privateKeyPath = sshKeyPath.trim();
        if (sshAuthMethod === 'password') config.password = passwordToStore;
        if (sshAuthMethod === 'password' && sshUseSudo) config.useSudo = true;

        const created = await window.electronAPI.environment.create({
          name: remoteEnvDisplayName,
          type: 'ssh',
          config,
          envVars: {},
        });
        setEnvironments(prev => [...prev, created]);
        onEnvironmentCreated?.(created);
        environmentName = created.name;
      } else if (remoteEnvChoice === 'coder') {
        const created = await window.electronAPI.environment.create({
          name: remoteEnvDisplayName,
          type: 'coder',
          config: { binaryPath: coderBinary.trim() || 'coder' },
          envVars: {},
        });
        setEnvironments(prev => [...prev, created]);
        onEnvironmentCreated?.(created);
        environmentName = created.name;
      }

      setSummary(prev => ({
        ...prev,
        defaultCliTool,
        customCliBinary: defaultCliTool === 'custom' ? customCliBinary.trim() : null,
        environmentName,
      }));
      setStep(4);
    } catch (err) {
      setEnvironmentError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEnvironment(false);
    }
  }, [
    coderBinary,
    customCliBinary,
    defaultCliTool,
    environmentCanContinue,
    onEnvironmentCreated,
    remoteEnvChoice,
    remoteEnvDisplayName,
    sshAuthMethod,
    sshDefaultDir,
    sshHost,
    sshKeyPath,
    sshPassword,
    sshPort,
    sshStoreInVault,
    sshUseSudo,
    sshUsername,
    sshVaultPath,
    suggestedSshVaultPath,
    vaultAvailableForSecrets,
  ]);

  const effectiveProviderBaseUrl = providerUrl.trim() || defaultProviderUrl(providerType);
  const providerRequiredFilled = !!providerName.trim()
    && !!effectiveProviderBaseUrl
    && !!providerToken.trim()
    && (providerType !== 'ado' || !!providerOrg.trim());

  const handleProviderSave = useCallback(async () => {
    if (!providerRequiredFilled) return;
    setSavingProvider(true);
    setTestingProvider(false);
    setProviderError(null);
    setProviderTestResult(null);
    try {
      let tokenToStore = providerToken.trim();
      if (isVaultRef(tokenToStore)) {
        // Store existing Vault references verbatim.
      } else if (providerStoreInVault) {
        if (!vaultAvailableForSecrets) {
          setProviderError('Log in to Vault before storing the provider token there.');
          return;
        }
        const ref = (providerVaultPath || suggestedProviderVaultPath).trim();
        await window.electronAPI.vault.writeSecret(ref, tokenToStore);
        tokenToStore = ref;
      }

      const provider = await window.electronAPI.gitProvider.create({
        name: providerName.trim(),
        type: providerType,
        baseUrl: effectiveProviderBaseUrl,
        organization: providerType === 'ado' ? providerOrg.trim() : undefined,
        defaultProject: providerType === 'ado' && providerDefaultProject.trim()
          ? providerDefaultProject.trim()
          : undefined,
        token: tokenToStore,
      });
      setGitProviders(prev => [...prev, provider]);
      setProviderAdded(provider.name);
      setSummary(prev => ({
        ...prev,
        gitProviderName: provider.name,
      }));

      setTestingProvider(true);
      const result = await window.electronAPI.gitProvider.test(provider.id);
      setProviderTestResult(result);
      setProviderName('');
      setProviderUrl('');
      setProviderOrg('');
      setProviderDefaultProject('');
      setProviderToken('');
      setProviderStoreInVault(false);
      setProviderVaultPath('');
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProvider(false);
      setTestingProvider(false);
    }
  }, [
    effectiveProviderBaseUrl,
    providerDefaultProject,
    providerName,
    providerOrg,
    providerRequiredFilled,
    providerStoreInVault,
    providerToken,
    providerType,
    providerVaultPath,
    suggestedProviderVaultPath,
    vaultAvailableForSecrets,
  ]);

  const handleProviderAddAnother = useCallback(() => {
    setProviderAdded(null);
    setProviderError(null);
    setProviderTestResult(null);
  }, []);

  const handleVaultPickerSelect = useCallback((ref: string) => {
    if (vaultPickerTarget === 'sshPassword') {
      setSshPassword(ref);
      setSshStoreInVault(false);
    } else if (vaultPickerTarget === 'providerToken') {
      setProviderToken(ref);
      setProviderStoreInVault(false);
    }
    setVaultPickerTarget(null);
  }, [vaultPickerTarget]);

  useEscapeKey(handleClose, isOpen);
  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog dialog--wide">
        <div className="dialog-header">
          <span>{stepTitle(step)}</span>
          <button className="dialog-close" onClick={handleClose}>&times;</button>
        </div>

        <div className="dialog-body">
          <div className="wizard-step-indicator">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div
                key={i}
                className={`wizard-dot${i === step ? ' wizard-dot--active' : ''}${i < step ? ' wizard-dot--done' : ''}`}
              />
            ))}
          </div>

          {step === 0 && (
            <div className="wizard-welcome">
              <img src={logoSrc} alt="Tether" style={{ width: 72, height: 72 }} />
              <div className="wizard-welcome-title">Welcome to Tether</div>
              <div className="wizard-welcome-desc">
                Configure the basics for local, SSH, or Coder-backed sessions with Claude Code,
                Codex CLI, GitHub Copilot CLI, OpenCode, or a custom binary.
              </div>
              <div className="wizard-overview">
                <div>Projects folder</div>
                <div>Vault login</div>
                <div>Environment and CLI</div>
                <div>Git provider</div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="form-group">
              <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                Where do you keep your projects?
              </label>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Tether uses this as the quick-pick root for existing repos, clone destinations,
                and the New folder flow.
              </p>
              <div className="form-row">
                <input
                  className="form-input"
                  value={reposRoot}
                  onChange={e => setReposRoot(e.target.value)}
                  placeholder="C:\repo"
                  spellCheck={false}
                />
                <button className="form-btn" onClick={handleBrowse}>Browse...</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Secure secrets with Vault
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  Vault lets Tether store SSH passwords, API keys, and Git provider tokens as
                  <code>vault://</code> references instead of plaintext values.
                </p>
              </div>

              <div className="form-group">
                <label className="form-radio-label">
                  <input
                    type="checkbox"
                    checked={vaultEnabled}
                    onChange={e => setVaultEnabled(e.target.checked)}
                  />
                  Enable Vault integration
                </label>
              </div>

              {vaultEnabled && (
                <>
                  <div className="form-group">
                    <label className="form-label">Vault Address</label>
                    <input
                      className="form-input"
                      value={vaultAddr}
                      onChange={e => setVaultAddr(e.target.value)}
                      placeholder="https://vault.example.com"
                      spellCheck={false}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">OIDC Role</label>
                    <input
                      className="form-input"
                      value={vaultRole}
                      onChange={e => setVaultRole(e.target.value)}
                      placeholder="default"
                      spellCheck={false}
                    />
                  </div>
                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">KV Mount Path</label>
                      <input
                        className="form-input"
                        value={vaultMount}
                        onChange={e => setVaultMount(e.target.value)}
                        placeholder="secret"
                        spellCheck={false}
                      />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">Namespace (optional)</label>
                      <input
                        className="form-input"
                        value={vaultNamespace}
                        onChange={e => setVaultNamespace(e.target.value)}
                        placeholder=""
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="wizard-inline-actions">
                    <button
                      className="form-btn"
                      onClick={handleVaultLogin}
                      disabled={vaultLoggingIn || !vaultReadyToSave}
                    >
                      {vaultLoggingIn ? 'Opening browser...' : vaultStatus.loggedIn ? 'Log In Again' : 'Save & Log In'}
                    </button>
                    <button
                      className="form-btn"
                      onClick={() => setShowMigrateDialog(true)}
                      disabled={!vaultStatus.loggedIn}
                    >
                      Migrate Existing Secrets...
                    </button>
                    <span className={`wizard-status-pill ${vaultStatus.loggedIn ? 'wizard-status-pill--ok' : ''}`}>
                      {vaultStatus.loggedIn ? 'Logged in' : 'Not logged in'}
                    </span>
                  </div>
                </>
              )}
              {vaultError && (
                <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 8 }}>
                  {vaultError}
                </p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Choose your default CLI and environment
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  Local is already available. Add SSH or Coder here only if you want the first session
                  to run somewhere else.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Default CLI Tool</label>
                <select
                  className="form-input"
                  value={defaultCliTool}
                  onChange={e => setDefaultCliTool(e.target.value as CliToolId)}
                >
                  {CLI_TOOL_IDS.map(id => (
                    <option key={id} value={id}>{CLI_TOOL_REGISTRY[id].displayName}</option>
                  ))}
                </select>
                {defaultCliTool === 'custom' ? (
                  <div style={{ marginTop: 8 }}>
                    <input
                      className="form-input"
                      value={customCliBinary}
                      onChange={e => setCustomCliBinary(e.target.value)}
                      placeholder="my-agent-cli"
                      spellCheck={false}
                    />
                    <p className="form-hint" style={{ marginTop: 4 }}>
                      Name or path of the binary Tether should preselect for custom sessions.
                    </p>
                  </div>
                ) : (
                  <p className="form-hint" style={{ marginTop: 4 }}>
                    {cliStatusLoaded
                      ? selectedCliStatus
                        ? `${CLI_TOOL_REGISTRY[defaultCliTool].binaryName} was found on this machine.`
                        : `${CLI_TOOL_REGISTRY[defaultCliTool].binaryName} was not found on this machine's PATH. Remote environments still need their own install.`
                      : 'Checking local PATH...'}
                  </p>
                )}
              </div>

              <div className="wizard-cli-status-list">
                {KNOWN_CLI_TOOL_IDS.map(id => (
                  <span key={id} className={`wizard-status-pill ${cliInstallStatus[id] ? 'wizard-status-pill--ok' : ''}`}>
                    {CLI_TOOL_REGISTRY[id].displayName}: {cliStatusLoaded ? (cliInstallStatus[id] ? 'found' : 'not found') : 'checking'}
                  </span>
                ))}
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label">Environment setup</label>
                {environments.length > 0 && (
                  <p className="form-hint" style={{ marginBottom: 8 }}>
                    Existing environments: {environments.map(env => `${env.name} (${env.type})`).join(', ')}
                  </p>
                )}
                <select
                  className="form-input"
                  value={remoteEnvChoice}
                  onChange={e => {
                    setRemoteEnvChoice(e.target.value as RemoteEnvironmentChoice);
                    setEnvironmentError(null);
                  }}
                >
                  <option value="none">Use Local for now</option>
                  <option value="ssh">Add SSH environment</option>
                  <option value="coder">Add Coder environment</option>
                </select>
              </div>

              {remoteEnvChoice !== 'none' && (
                <div className="wizard-nested-form">
                  <div className="form-group">
                    <label className="form-label">Environment Name</label>
                    <input
                      className="form-input"
                      value={remoteEnvName}
                      onChange={e => setRemoteEnvName(e.target.value)}
                      placeholder={remoteEnvChoice === 'ssh' ? 'Dev Server' : 'Coder'}
                    />
                  </div>

                  {remoteEnvChoice === 'ssh' && (
                    <>
                      <div className="form-row">
                        <div className="form-group" style={{ flex: 2 }}>
                          <label className="form-label">Host</label>
                          <input
                            className="form-input"
                            value={sshHost}
                            onChange={e => setSshHost(e.target.value)}
                            placeholder="dev.example.com"
                            spellCheck={false}
                          />
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                          <label className="form-label">Port</label>
                          <input
                            className="form-input"
                            value={sshPort}
                            onChange={e => setSshPort(e.target.value)}
                            placeholder="22"
                            spellCheck={false}
                          />
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group" style={{ flex: 1 }}>
                          <label className="form-label">Username</label>
                          <input
                            className="form-input"
                            value={sshUsername}
                            onChange={e => setSshUsername(e.target.value)}
                            placeholder="root"
                            spellCheck={false}
                          />
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                          <label className="form-label">Default Directory</label>
                          <input
                            className="form-input"
                            value={sshDefaultDir}
                            onChange={e => setSshDefaultDir(e.target.value)}
                            placeholder="~/repos"
                            spellCheck={false}
                          />
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Authentication</label>
                        <div className="form-radio-group">
                          <label className="form-radio-label">
                            <input
                              type="radio"
                              checked={sshAuthMethod === 'agent'}
                              onChange={() => setSshAuthMethod('agent')}
                            />
                            SSH Agent
                          </label>
                          <label className="form-radio-label">
                            <input
                              type="radio"
                              checked={sshAuthMethod === 'key'}
                              onChange={() => setSshAuthMethod('key')}
                            />
                            Private Key File
                          </label>
                          <label className="form-radio-label">
                            <input
                              type="radio"
                              checked={sshAuthMethod === 'password'}
                              onChange={() => setSshAuthMethod('password')}
                            />
                            Password
                          </label>
                        </div>
                      </div>
                      {sshAuthMethod === 'key' && (
                        <div className="form-group">
                          <label className="form-label">Private Key Path</label>
                          <input
                            className="form-input"
                            value={sshKeyPath}
                            onChange={e => setSshKeyPath(e.target.value)}
                            placeholder="~/.ssh/id_ed25519"
                            spellCheck={false}
                          />
                        </div>
                      )}
                      {sshAuthMethod === 'password' && (
                        <div className="form-group">
                          <label className="form-label">Password</label>
                          <div className="form-row">
                            <input
                              className="form-input"
                              type={isVaultRef(sshPassword) ? 'text' : 'password'}
                              value={sshPassword}
                              onChange={e => setSshPassword(e.target.value)}
                              placeholder="Enter password"
                              spellCheck={false}
                            />
                            {vaultAvailableForSecrets && !isVaultRef(sshPassword) && (
                              <button className="form-btn" onClick={() => setVaultPickerTarget('sshPassword')}>
                                Browse Vault
                              </button>
                            )}
                            {isVaultRef(sshPassword) && (
                              <button className="form-btn" onClick={() => setSshPassword('')}>Clear</button>
                            )}
                          </div>
                          {vaultAvailableForSecrets && !isVaultRef(sshPassword) && (
                            <>
                              <label className="form-radio-label" style={{ marginTop: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={sshStoreInVault}
                                  onChange={e => setSshStoreInVault(e.target.checked)}
                                />
                                Store in Vault
                              </label>
                              {sshStoreInVault && (
                                <input
                                  className="form-input"
                                  value={sshVaultPath || suggestedSshVaultPath}
                                  onChange={e => setSshVaultPath(e.target.value)}
                                  placeholder={suggestedSshVaultPath}
                                  spellCheck={false}
                                  style={{ marginTop: 4 }}
                                />
                              )}
                            </>
                          )}
                          <label className="form-radio-label" style={{ marginTop: 8 }}>
                            <input
                              type="checkbox"
                              checked={sshUseSudo}
                              onChange={e => setSshUseSudo(e.target.checked)}
                            />
                            Run as root (sudo -i)
                          </label>
                        </div>
                      )}
                    </>
                  )}

                  {remoteEnvChoice === 'coder' && (
                    <div className="form-group">
                      <label className="form-label">Coder CLI Path</label>
                      <input
                        className="form-input"
                        value={coderBinary}
                        onChange={e => setCoderBinary(e.target.value)}
                        placeholder="coder"
                        spellCheck={false}
                      />
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        Leave as <code>coder</code> if it is on PATH. Run <code>coder login</code> before creating Coder sessions.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {environmentError && (
                <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 8 }}>
                  {environmentError}
                </p>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Connect a Git provider
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  Add GitHub, Azure DevOps, or Gitea if you want repo browse, clone, and remote-create
                  from the New Session dialog.
                </p>
                {gitProviders.length > 0 && (
                  <p className="form-hint">
                    Existing providers: {gitProviders.map(provider => `${provider.name} (${provider.type})`).join(', ')}
                  </p>
                )}
              </div>

              {providerAdded && (
                <div className="wizard-provider-added">
                  <span className="wizard-summary-check">{'\u2713'}</span>
                  <span>
                    <strong>{providerAdded}</strong> saved.
                    {testingProvider && ' Testing connection...'}
                    {providerTestResult && (providerTestResult.ok
                      ? ' Connection test passed.'
                      : ` Connection test failed: ${providerTestResult.error || 'Unknown error'}`)}
                  </span>
                </div>
              )}

              {!providerAdded ? (
                <>
                  <div className="form-group">
                    <label className="form-label">Type</label>
                    <div className="form-radio-group">
                      <label className="form-radio-label">
                        <input
                          type="radio"
                          name="providerType"
                          checked={providerType === 'github'}
                          onChange={() => setProviderType('github')}
                        />
                        GitHub
                      </label>
                      <label className="form-radio-label">
                        <input
                          type="radio"
                          name="providerType"
                          checked={providerType === 'ado'}
                          onChange={() => setProviderType('ado')}
                        />
                        Azure DevOps
                      </label>
                      <label className="form-radio-label">
                        <input
                          type="radio"
                          name="providerType"
                          checked={providerType === 'gitea'}
                          onChange={() => setProviderType('gitea')}
                        />
                        Gitea
                      </label>
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input
                      className="form-input"
                      value={providerName}
                      onChange={e => setProviderName(e.target.value)}
                      placeholder={providerType === 'github' ? 'GitHub' : providerType === 'ado' ? 'Azure DevOps' : 'Gitea'}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Base URL</label>
                    <input
                      className="form-input"
                      value={providerUrl}
                      onChange={e => setProviderUrl(e.target.value)}
                      placeholder={
                        providerType === 'gitea' ? 'https://gitea.example.com'
                        : `Default: ${defaultProviderUrl(providerType)}`
                      }
                      spellCheck={false}
                    />
                    {providerType === 'github' && (
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        Leave blank for github.com. For GitHub Enterprise, use a URL like https://github.example.com/api/v3.
                      </p>
                    )}
                  </div>
                  {providerType === 'ado' && (
                    <>
                      <div className="form-group">
                        <label className="form-label">Organization</label>
                        <input
                          className="form-input"
                          value={providerOrg}
                          onChange={e => setProviderOrg(e.target.value)}
                          placeholder="my-org"
                          spellCheck={false}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Default Project (optional)</label>
                        <input
                          className="form-input"
                          value={providerDefaultProject}
                          onChange={e => setProviderDefaultProject(e.target.value)}
                          placeholder="Project name"
                          spellCheck={false}
                        />
                      </div>
                    </>
                  )}
                  <div className="form-group">
                    <label className="form-label">Personal Access Token</label>
                    <div className="form-row">
                      <input
                        type={isVaultRef(providerToken) ? 'text' : 'password'}
                        className="form-input"
                        value={providerToken}
                        onChange={e => setProviderToken(e.target.value)}
                        placeholder="ghp_... or PAT"
                        spellCheck={false}
                      />
                      {vaultAvailableForSecrets && !isVaultRef(providerToken) && (
                        <button className="form-btn" onClick={() => setVaultPickerTarget('providerToken')}>
                          Browse Vault
                        </button>
                      )}
                      {isVaultRef(providerToken) && (
                        <button className="form-btn" onClick={() => setProviderToken('')}>Clear</button>
                      )}
                    </div>
                    {providerType === 'github' && (
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        Classic PAT: <code>repo</code> + <code>read:org</code>. Fine-grained PAT: Contents (Read).
                      </p>
                    )}
                    {providerType === 'gitea' && (
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        Scoped token needs <code>read:user</code> + <code>read:repository</code> to browse,
                        plus <code>write:user</code> + <code>write:repository</code> to create new repos.
                      </p>
                    )}
                    {providerType === 'ado' && (
                      <p className="form-hint" style={{ marginTop: 4 }}>
                        PAT needs <strong>Code (Read)</strong> to browse, or <strong>Code (Read &amp; write)</strong>
                        to create repos. <strong>Project and Team (Read)</strong> is required for the project picker.
                      </p>
                    )}
                    {vaultAvailableForSecrets && !isVaultRef(providerToken) && (
                      <>
                        <label className="form-radio-label" style={{ marginTop: 6 }}>
                          <input
                            type="checkbox"
                            checked={providerStoreInVault}
                            onChange={e => setProviderStoreInVault(e.target.checked)}
                          />
                          Store in Vault
                        </label>
                        {providerStoreInVault && (
                          <input
                            className="form-input"
                            value={providerVaultPath || suggestedProviderVaultPath}
                            onChange={e => setProviderVaultPath(e.target.value)}
                            placeholder={suggestedProviderVaultPath}
                            spellCheck={false}
                            style={{ marginTop: 4 }}
                          />
                        )}
                      </>
                    )}
                  </div>
                  {providerError && (
                    <p className="form-hint" style={{ color: 'var(--status-dead)', marginBottom: 8 }}>
                      {providerError}
                    </p>
                  )}
                </>
              ) : (
                <div className="wizard-inline-actions">
                  <button className="form-btn" onClick={handleProviderAddAnother}>
                    Add Another Provider
                  </button>
                  <button className="form-btn form-btn--primary" onClick={() => setStep(5)}>
                    Continue
                  </button>
                </div>
              )}
            </>
          )}

          {step === 5 && (
            <div className="wizard-welcome">
              <div className="wizard-welcome-title">You're ready to start</div>
              <div className="wizard-summary">
                <div className="wizard-summary-item">
                  <span className={summary.reposRoot ? 'wizard-summary-check' : 'wizard-summary-skip'}>
                    {summary.reposRoot ? '\u2713' : '\u2014'}
                  </span>
                  <span>Projects root: {summary.reposRoot || 'Skipped'}</span>
                </div>
                <div className="wizard-summary-item">
                  <span className="wizard-summary-check">{'\u2713'}</span>
                  <span>Default CLI: {summary.defaultCliTool === 'custom' ? summary.customCliBinary || 'Custom' : CLI_TOOL_REGISTRY[summary.defaultCliTool].displayName}</span>
                </div>
                <div className="wizard-summary-item">
                  <span className={summary.environmentName ? 'wizard-summary-check' : 'wizard-summary-skip'}>
                    {summary.environmentName ? '\u2713' : '\u2014'}
                  </span>
                  <span>Remote environment: {summary.environmentName || 'Skipped - Local is available'}</span>
                </div>
                <div className="wizard-summary-item">
                  <span className={summary.vaultEnabled ? 'wizard-summary-check' : 'wizard-summary-skip'}>
                    {summary.vaultEnabled ? '\u2713' : '\u2014'}
                  </span>
                  <span>Vault: {summary.vaultEnabled ? (summary.vaultLoggedIn ? 'Enabled and logged in' : 'Enabled') : 'Skipped'}</span>
                </div>
                <div className="wizard-summary-item">
                  <span className={summary.gitProviderName ? 'wizard-summary-check' : 'wizard-summary-skip'}>
                    {summary.gitProviderName ? '\u2713' : '\u2014'}
                  </span>
                  <span>Git provider: {summary.gitProviderName || 'Skipped'}</span>
                </div>
              </div>
              <div className="wizard-welcome-desc">
                You can change CLI, Vault, and provider settings later in Settings. The projects root is available from New Session.
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          {step === 0 && (
            <>
              <button className="form-btn" onClick={() => handleComplete(false)}>
                Skip Setup
              </button>
              <button className="form-btn form-btn--primary" onClick={() => setStep(1)}>
                Get Started
              </button>
            </>
          )}
          {step === 1 && (
            <>
              <button className="form-btn" onClick={() => setStep(0)}>Back</button>
              <button className="form-btn" onClick={() => setStep(2)}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!reposRoot.trim()}
                onClick={() => { handleReposNext().catch(() => undefined); }}
              >
                Save & Continue
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="form-btn" onClick={() => setStep(1)}>Back</button>
              <button className="form-btn" onClick={() => setStep(3)}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!vaultReadyToSave}
                onClick={() => { handleVaultSave().catch(() => undefined); }}
              >
                Save & Continue
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button className="form-btn" onClick={() => setStep(2)}>Back</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!environmentCanContinue || savingEnvironment}
                onClick={() => { handleEnvironmentAndCliNext().catch(() => undefined); }}
              >
                {savingEnvironment ? 'Saving...' : 'Save & Continue'}
              </button>
            </>
          )}
          {step === 4 && !providerAdded && (
            <>
              <button className="form-btn" onClick={() => setStep(3)}>Back</button>
              <button className="form-btn" onClick={() => setStep(5)}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!providerRequiredFilled || savingProvider}
                onClick={() => { handleProviderSave().catch(() => undefined); }}
              >
                {savingProvider ? 'Saving...' : 'Save & Test'}
              </button>
            </>
          )}
          {step === 5 && (
            <>
              <button className="form-btn" onClick={() => handleComplete(false)}>
                Start Using Tether
              </button>
              <button className="form-btn form-btn--primary" onClick={() => handleComplete(true)}>
                Create First Session
              </button>
            </>
          )}
        </div>

        <VaultPickerDialog
          isOpen={vaultPickerTarget !== null}
          onClose={() => setVaultPickerTarget(null)}
          onSelect={handleVaultPickerSelect}
        />
        <MigrateToVaultDialog isOpen={showMigrateDialog} onClose={() => setShowMigrateDialog(false)} />
      </div>
    </div>
  );
}
