import { useState, useCallback } from 'react';
import logoSrc from '../assets/logo.png';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { GitProviderType, VaultConfig } from '../../shared/types';

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

type WizardStep = 0 | 1 | 2 | 3 | 4;
const TOTAL_STEPS = 5;

interface Summary {
  reposRoot: string | null;
  gitProviderName: string | null;
  vaultEnabled: boolean;
}

export function SetupWizard({ isOpen, onClose }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(0);
  const [reposRoot, setReposRoot] = useState('');

  // Git provider state
  const [providerType, setProviderType] = useState<GitProviderType>('gitea');
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerOrg, setProviderOrg] = useState('');
  const [providerToken, setProviderToken] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerAdded, setProviderAdded] = useState<string | null>(null);

  // Vault state
  const [vaultEnabled, setVaultEnabled] = useState(false);
  const [vaultAddr, setVaultAddr] = useState('');
  const [vaultRole, setVaultRole] = useState('');
  const [vaultMount, setVaultMount] = useState('secret');

  // Summary
  const [summary, setSummary] = useState<Summary>({
    reposRoot: null,
    gitProviderName: null,
    vaultEnabled: false,
  });

  const resetForm = useCallback(() => {
    setStep(0);
    setReposRoot('');
    setProviderType('gitea');
    setProviderName('');
    setProviderUrl('');
    setProviderOrg('');
    setProviderToken('');
    setProviderError(null);
    setProviderAdded(null);
    setVaultEnabled(false);
    setVaultAddr('');
    setVaultRole('');
    setVaultMount('secret');
    setSummary({ reposRoot: null, gitProviderName: null, vaultEnabled: false });
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    resetForm();
  }, [onClose, resetForm]);

  const handleBrowse = useCallback(async () => {
    const dir = await window.electronAPI.dialog.openDirectory();
    if (dir) setReposRoot(dir);
  }, []);

  const handleReposNext = useCallback(async () => {
    if (reposRoot.trim()) {
      await window.electronAPI.config.set('reposRoot', reposRoot.trim());
      setSummary(prev => ({ ...prev, reposRoot: reposRoot.trim() }));
    }
    setStep(2);
  }, [reposRoot]);

  const handleReposSkip = useCallback(() => {
    setStep(2);
  }, []);

  const handleProviderSave = useCallback(async () => {
    if (!providerName.trim() || !providerUrl.trim() || !providerToken.trim()) return;
    setProviderError(null);
    try {
      await window.electronAPI.gitProvider.create({
        name: providerName.trim(),
        type: providerType,
        baseUrl: providerUrl.trim(),
        organization: providerType === 'ado' ? providerOrg.trim() : undefined,
        token: providerToken.trim(),
      });
      setSummary(prev => ({ ...prev, gitProviderName: providerName.trim() }));
      setProviderAdded(providerName.trim());
      setProviderName('');
      setProviderUrl('');
      setProviderOrg('');
      setProviderToken('');
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : String(err));
    }
  }, [providerName, providerUrl, providerToken, providerType, providerOrg]);

  const handleProviderContinue = useCallback(() => {
    setStep(3);
  }, []);

  const handleProviderSkip = useCallback(() => {
    setStep(3);
  }, []);

  const handleProviderAddAnother = useCallback(() => {
    setProviderAdded(null);
    setProviderError(null);
  }, []);

  const handleVaultSave = useCallback(async () => {
    if (vaultEnabled) {
      const config: VaultConfig = {
        enabled: true,
        addr: vaultAddr.trim(),
        role: vaultRole.trim(),
        mount: vaultMount.trim() || 'secret',
      };
      await window.electronAPI.vault.setConfig(config);
      setSummary(prev => ({ ...prev, vaultEnabled: true }));
    }
    setStep(4);
  }, [vaultEnabled, vaultAddr, vaultRole, vaultMount]);

  const handleVaultSkip = useCallback(() => {
    setStep(4);
  }, []);

  useEscapeKey(handleClose, isOpen);
  if (!isOpen) return null;

  const providerRequiredFilled = providerName.trim() && providerUrl.trim() && providerToken.trim();

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') handleClose(); }}
    >
      <div className="dialog dialog--wide">
        {/* Step indicator */}
        <div className="dialog-header">
          <span>
            {step === 0 && 'Welcome'}
            {step === 1 && 'Repos Root'}
            {step === 2 && 'Git Provider'}
            {step === 3 && 'Vault'}
            {step === 4 && 'All Done'}
          </span>
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

          {/* Step 0: Welcome */}
          {step === 0 && (
            <div className="wizard-welcome">
              <img src={logoSrc} alt="Tether" style={{ width: 72, height: 72 }} />
              <div className="wizard-welcome-title">Welcome to Tether</div>
              <div className="wizard-welcome-desc">
                Tether helps you manage Claude Code and Codex CLI sessions across your machines.
                Let's get a few things set up so you can hit the ground running.
              </div>
            </div>
          )}

          {/* Step 1: Repos Root */}
          {step === 1 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Where do you keep your projects?
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  Point Tether at the folder where you keep your code repos. This makes it quick
                  to pick a project when starting a new session.
                </p>
                <div className="form-row">
                  <input
                    className="form-input"
                    value={reposRoot}
                    onChange={e => setReposRoot(e.target.value)}
                    placeholder="C:\Users\you\repos"
                    spellCheck={false}
                  />
                  <button className="form-btn" onClick={handleBrowse}>Browse...</button>
                </div>
              </div>
            </>
          )}

          {/* Step 2: Git Provider */}
          {step === 2 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Connect a Git provider
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  If your team uses Gitea or Azure DevOps, connect it here to browse and clone
                  repos right from Tether. You can add more later in Settings.
                </p>
              </div>

              {providerAdded && (
                <div className="wizard-provider-added">
                  <span className="wizard-summary-check">{'\u2713'}</span>
                  <span><strong>{providerAdded}</strong> added successfully.</span>
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
                          checked={providerType === 'gitea'}
                          onChange={() => setProviderType('gitea')}
                        />
                        Gitea
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
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input
                      className="form-input"
                      value={providerName}
                      onChange={e => setProviderName(e.target.value)}
                      placeholder="My Gitea Server"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Base URL</label>
                    <input
                      className="form-input"
                      value={providerUrl}
                      onChange={e => setProviderUrl(e.target.value)}
                      placeholder={providerType === 'gitea' ? 'https://gitea.example.com' : 'https://dev.azure.com'}
                      spellCheck={false}
                    />
                  </div>
                  {providerType === 'ado' && (
                    <div className="form-group">
                      <label className="form-label">Organization</label>
                      <input
                        className="form-input"
                        value={providerOrg}
                        onChange={e => setProviderOrg(e.target.value)}
                        placeholder="my-org"
                      />
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label">Personal Access Token</label>
                    <input
                      type="password"
                      className="form-input"
                      value={providerToken}
                      onChange={e => setProviderToken(e.target.value)}
                      placeholder="ghp_... or PAT"
                      spellCheck={false}
                    />
                  </div>
                  {providerError && (
                    <p className="form-hint" style={{ color: 'var(--status-dead)', marginBottom: 8 }}>
                      {providerError}
                    </p>
                  )}
                </>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="form-btn" onClick={handleProviderAddAnother}>
                    Add Another Provider
                  </button>
                  <button className="form-btn form-btn--primary" onClick={handleProviderContinue}>
                    Continue
                  </button>
                </div>
              )}
            </>
          )}

          {/* Step 3: Vault */}
          {step === 3 && (
            <>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  Secure your secrets with Vault
                </label>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  If your organization uses HashiCorp Vault, Tether can pull passwords and tokens
                  from it instead of storing them locally.
                </p>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  Not sure? Skip this — you can always set it up later in Settings.
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
                  <div className="form-group">
                    <label className="form-label">KV Mount Path</label>
                    <input
                      className="form-input"
                      value={vaultMount}
                      onChange={e => setVaultMount(e.target.value)}
                      placeholder="secret"
                      spellCheck={false}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* Step 4: All Done */}
          {step === 4 && (
            <div className="wizard-welcome">
              <div className="wizard-welcome-title">You're all set!</div>
              <div className="wizard-summary">
                <div className="wizard-summary-item">
                  {summary.reposRoot ? (
                    <span className="wizard-summary-check">{'\u2713'}</span>
                  ) : (
                    <span className="wizard-summary-skip">{'\u2014'}</span>
                  )}
                  <span>
                    Repos root: {summary.reposRoot ? summary.reposRoot : 'Skipped'}
                  </span>
                </div>
                <div className="wizard-summary-item">
                  {summary.gitProviderName ? (
                    <span className="wizard-summary-check">{'\u2713'}</span>
                  ) : (
                    <span className="wizard-summary-skip">{'\u2014'}</span>
                  )}
                  <span>
                    Git provider: {summary.gitProviderName ? summary.gitProviderName : 'Skipped'}
                  </span>
                </div>
                <div className="wizard-summary-item">
                  {summary.vaultEnabled ? (
                    <span className="wizard-summary-check">{'\u2713'}</span>
                  ) : (
                    <span className="wizard-summary-skip">{'\u2014'}</span>
                  )}
                  <span>
                    Vault: {summary.vaultEnabled ? 'Enabled' : 'Skipped'}
                  </span>
                </div>
              </div>
              <div className="wizard-welcome-desc">
                You can change any of these in Settings, or re-run this wizard from Help &gt; Setup Wizard.
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          {step === 0 && (
            <button className="form-btn form-btn--primary" onClick={() => setStep(1)}>
              Get Started
            </button>
          )}
          {step === 1 && (
            <>
              <button className="form-btn" onClick={handleReposSkip}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!reposRoot.trim()}
                onClick={handleReposNext}
              >
                Next
              </button>
            </>
          )}
          {step === 2 && !providerAdded && (
            <>
              <button className="form-btn" onClick={handleProviderSkip}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                disabled={!providerRequiredFilled}
                onClick={handleProviderSave}
              >
                Save &amp; Continue
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button className="form-btn" onClick={handleVaultSkip}>Skip</button>
              <button
                className="form-btn form-btn--primary"
                onClick={handleVaultSave}
              >
                {vaultEnabled ? 'Save & Finish' : 'Finish'}
              </button>
            </>
          )}
          {step === 4 && (
            <button className="form-btn form-btn--primary" onClick={handleClose}>
              Start Using Tether
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
