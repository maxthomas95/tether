import { useState, useEffect } from 'react';
import { EnvVarEditor } from '../EnvVarEditor';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { EnvironmentType } from '../../../shared/types';
import { suggestVaultPath, VAULT_REF_PREFIX } from '../../utils/vault-path';

interface NewEnvironmentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => void;
  /** When set, the dialog opens in edit mode with pre-filled values. */
  editing?: { id: string; name: string; type: EnvironmentType; config: Record<string, unknown>; envVars: Record<string, string> } | null;
  onUpdate?: (id: string, name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => void;
}

export function NewEnvironmentDialog({ isOpen, onClose, onCreate, editing, onUpdate }: NewEnvironmentDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvironmentType>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [password, setPassword] = useState('');
  const [storeInVault, setStoreInVault] = useState(false);
  const [vaultPath, setVaultPath] = useState('');
  const [authMethod, setAuthMethod] = useState<'agent' | 'key' | 'password'>('agent');
  const [defaultDir, setDefaultDir] = useState('~');
  const [useSudo, setUseSudo] = useState(false);
  const [coderBinary, setCoderBinary] = useState('coder');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [vaultConnected, setVaultConnected] = useState(false);
  const [vaultMount, setVaultMount] = useState('secret');
  const [vaultIdentity, setVaultIdentity] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Pre-fill form when editing
  useEffect(() => {
    if (!isOpen || !editing) return;
    setName(editing.name);
    setType(editing.type);
    setEnvVars(editing.envVars || {});
    const cfg = editing.config || {};
    if (editing.type === 'ssh') {
      setHost((cfg.host as string) || '');
      setPort(String(cfg.port || 22));
      setUsername((cfg.username as string) || '');
      setDefaultDir((cfg.defaultDir as string) || '~');
      setUseSudo(!!(cfg.useSudo));
      if (cfg.useAgent) {
        setAuthMethod('agent');
      } else if (cfg.privateKeyPath) {
        setAuthMethod('key');
        setKeyPath(cfg.privateKeyPath as string);
      } else if (cfg.password) {
        setAuthMethod('password');
        // Don't pre-fill actual password for security — show placeholder
        setPassword('');
      } else {
        setAuthMethod('agent');
      }
    } else if (editing.type === 'coder') {
      setCoderBinary((cfg.binaryPath as string) || 'coder');
    }
  }, [isOpen, editing]);

  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI.vault.status().then(s => {
      setVaultConnected(s.enabled && s.loggedIn);
      setVaultIdentity(s.identity);
    }).catch(() => setVaultConnected(false));
    window.electronAPI.vault.getConfig().then(c => { if (c.mount) setVaultMount(c.mount); }).catch(() => {});
  }, [isOpen]);

  useEscapeKey(onClose, isOpen);

  if (!isOpen) return null;

  const passwordReady =
    authMethod !== 'password' || !!password;

  const suggestedVaultPath = suggestVaultPath(
    { mount: vaultMount },
    { identity: vaultIdentity },
    'ssh',
    name || host || 'host',
    'password',
  );

  const handleSubmit = async () => {
    if (!name.trim() || (type === 'ssh' && !host.trim())) return;

    setCreating(true);
    setCreateError(null);

    const config: Record<string, unknown> = {};
    if (type === 'ssh') {
      config.host = host.trim();
      config.port = parseInt(port) || 22;
      config.username = username.trim() || 'root';
      config.defaultDir = defaultDir.trim() || '~';
      if (authMethod === 'agent') {
        config.useAgent = true;
      } else if (authMethod === 'key' && keyPath.trim()) {
        config.privateKeyPath = keyPath.trim();
      } else if (authMethod === 'password' && password) {
        if (storeInVault) {
          const ref = (vaultPath || suggestedVaultPath).trim();
          try {
            await window.electronAPI.vault.writeSecret(ref, password);
          } catch (err) {
            setCreateError(`Failed to write to Vault: ${err instanceof Error ? err.message : String(err)}`);
            setCreating(false);
            return;
          }
          config.password = ref;
        } else {
          config.password = password;
        }
      } else if (authMethod === 'password' && !password && editing) {
        // Editing mode: keep existing password if not changed
        config.password = editing.config.password;
      }
      if (useSudo) {
        config.useSudo = true;
      }
    } else if (type === 'coder') {
      config.binaryPath = coderBinary.trim() || 'coder';
    }

    if (editing && onUpdate) {
      onUpdate(editing.id, name.trim(), type, config, envVars);
    } else {
      onCreate(name.trim(), type, config, envVars);
    }
    // Reset form
    resetForm();
    onClose();
  };

  const resetForm = () => {
    setName(''); setHost(''); setPort('22'); setUsername('');
    setKeyPath(''); setPassword(''); setAuthMethod('agent'); setDefaultDir('~'); setEnvVars({});
    setStoreInVault(false); setVaultPath(''); setCreateError(null); setCreating(false); setUseSudo(false);
    setCoderBinary('coder');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && name.trim() && (type !== 'ssh' || host.trim())) handleSubmit();
  };

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" onKeyDown={handleKeyDown}>
        <div className="dialog-header">
          <span>{editing ? 'Edit Environment' : 'New Environment'}</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <div className="form-group">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My VM"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Type</label>
            <select
              className="form-input"
              value={type}
              onChange={e => setType(e.target.value as EnvironmentType)}
              disabled={!!editing}
            >
              <option value="ssh">SSH</option>
              <option value="local">Local</option>
              <option value="coder">Coder</option>
            </select>
          </div>

          {type === 'ssh' && (
            <>
              <div className="form-group">
                <label className="form-label">Host</label>
                <div className="form-row">
                  <input
                    className="form-input"
                    value={host}
                    onChange={e => setHost(e.target.value)}
                    placeholder="192.168.1.100"
                  />
                  <input
                    className="form-input"
                    value={port}
                    onChange={e => setPort(e.target.value)}
                    placeholder="22"
                    style={{ maxWidth: 70 }}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  className="form-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="root"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Authentication</label>
                <div className="form-radio-group">
                  <label className="form-radio-label">
                    <input
                      type="radio"
                      checked={authMethod === 'agent'}
                      onChange={() => setAuthMethod('agent')}
                    />
                    SSH Agent
                  </label>
                  <label className="form-radio-label">
                    <input
                      type="radio"
                      checked={authMethod === 'key'}
                      onChange={() => setAuthMethod('key')}
                    />
                    Private Key File
                  </label>
                  <label className="form-radio-label">
                    <input
                      type="radio"
                      checked={authMethod === 'password'}
                      onChange={() => setAuthMethod('password')}
                    />
                    Password
                  </label>
                </div>
                {authMethod === 'key' && (
                  <input
                    className="form-input"
                    value={keyPath}
                    onChange={e => setKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    style={{ marginTop: 6 }}
                  />
                )}
                {authMethod === 'password' && (
                  <div style={{ marginTop: 6 }}>
                    <input
                      className="form-input"
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={editing ? 'Leave empty to keep current' : 'Enter password'}
                    />
                    {vaultConnected && (
                      <>
                        <label className="form-radio-label" style={{ marginTop: 6, marginBottom: 4 }}>
                          <input
                            type="checkbox"
                            checked={storeInVault}
                            onChange={e => setStoreInVault(e.target.checked)}
                          />
                          Store in Vault
                        </label>
                        {storeInVault && (
                          <>
                            <input
                              className="form-input"
                              value={vaultPath || suggestedVaultPath}
                              onChange={e => setVaultPath(e.target.value)}
                              placeholder={suggestedVaultPath}
                              spellCheck={false}
                              style={{ marginTop: 4, fontSize: '0.85em' }}
                            />
                            <p className="form-hint" style={{ marginTop: 2 }}>
                              Password will be written to this Vault path on create.
                            </p>
                          </>
                        )}
                      </>
                    )}
                    {createError && (
                      <p className="form-hint" style={{ marginTop: 4, color: 'var(--status-dead)' }}>
                        {createError}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Default Directory</label>
                <input
                  className="form-input"
                  value={defaultDir}
                  onChange={e => setDefaultDir(e.target.value)}
                  placeholder="~/repos"
                />
              </div>

              {authMethod === 'password' && (
                <div className="form-group">
                  <label className="form-radio-label">
                    <input
                      type="checkbox"
                      checked={useSudo}
                      onChange={e => setUseSudo(e.target.checked)}
                    />
                    Run as root (sudo -i)
                  </label>
                  <span className="form-hint">
                    Elevate to root via sudo before launching. Uses the SSH password.
                  </span>
                </div>
              )}
            </>
          )}

          {type === 'coder' && (
            <>
              <div className="form-group">
                <label className="form-label">Coder CLI Path</label>
                <input
                  className="form-input"
                  value={coderBinary}
                  onChange={e => setCoderBinary(e.target.value)}
                  placeholder="coder"
                />
                <span className="form-hint">
                  Path to the `coder` binary. Leave as `coder` if it's on your PATH.
                  Tether uses `coder ssh &lt;workspace&gt;` to connect, so you must be
                  logged in via `coder login` before creating sessions.
                </span>
              </div>
            </>
          )}

          <details className="form-group">
            <summary className="form-label" style={{ cursor: 'pointer' }}>
              Environment Variables (optional)
            </summary>
            <div style={{ marginTop: 8 }}>
              <EnvVarEditor vars={envVars} onChange={setEnvVars} compact vaultEnabled={vaultConnected} />
            </div>
          </details>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button
            className="form-btn form-btn--primary"
            onClick={handleSubmit}
            disabled={creating || !name.trim() || (type === 'ssh' && (!host.trim() || (!editing && !passwordReady)))}
          >
            {creating
              ? (editing ? 'Saving\u2026' : 'Creating\u2026')
              : (editing ? 'Save Changes' : 'Create Environment')}
          </button>
        </div>
      </div>
    </div>
  );
}
