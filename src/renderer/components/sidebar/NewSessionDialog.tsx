import { useState, useEffect, useCallback, useMemo } from 'react';
import { EnvVarEditor } from '../EnvVarEditor';
import type { EnvironmentInfo } from '../../../shared/types';

interface NewSessionDialogProps {
  isOpen: boolean;
  environments: EnvironmentInfo[];
  onClose: () => void;
  onCreate: (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>, cliArgs?: string[]) => void;
}

export function NewSessionDialog({ isOpen, environments, onClose, onCreate }: NewSessionDialogProps) {
  const [envId, setEnvId] = useState<string>('');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');
  const [reposRoot, setReposRoot] = useState<string | null>(null);
  const [repoDirs, setRepoDirs] = useState<string[]>([]);
  const [showRepoConfig, setShowRepoConfig] = useState(false);
  const [reposRootInput, setReposRootInput] = useState('');
  const [sessionEnvVars, setSessionEnvVars] = useState<Record<string, string>>({});
  const [appDefaultEnvVars, setAppDefaultEnvVars] = useState<Record<string, string>>({});
  const [defaultCliFlags, setDefaultCliFlags] = useState<string[]>([]);
  const [sessionCliFlags, setSessionCliFlags] = useState<string[]>([]);
  const [customFlag, setCustomFlag] = useState('');

  // Load repos root, app default env vars, and CLI flags
  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI.config.getDefaultEnvVars?.()?.then(setAppDefaultEnvVars).catch(() => {});
    window.electronAPI.config.getDefaultCliFlags?.()?.then(setDefaultCliFlags).catch(() => {});
    window.electronAPI.config.get('reposRoot').then(val => {
      setReposRoot(val);
      if (val) {
        setReposRootInput(val);
        window.electronAPI.scanReposDir(val).then(setRepoDirs);
      }
    });
  }, [isOpen]);

  // Auto-fill default directory when environment changes
  useEffect(() => {
    if (!envId) return;
    const env = environments.find(e => e.id === envId);
    if (env?.config?.defaultDir && !directory) {
      setDirectory(env.config.defaultDir as string);
    }
  }, [envId, environments, directory]);

  // Set default env when dialog opens
  useEffect(() => {
    if (isOpen && environments.length > 0 && !envId) {
      setEnvId(environments[0].id);
    }
  }, [isOpen, environments, envId]);

  const saveReposRoot = useCallback(async () => {
    const val = reposRootInput.trim();
    if (val) {
      await window.electronAPI.config.set('reposRoot', val);
      setReposRoot(val);
      const dirs = await window.electronAPI.scanReposDir(val);
      setRepoDirs(dirs);
    }
    setShowRepoConfig(false);
  }, [reposRootInput]);

  const selectedEnv = environments.find(e => e.id === envId);
  const isSSH = selectedEnv?.type === 'ssh';

  // Compute inherited env vars for display (must be before early return — Rules of Hooks)
  const inheritedVars = useMemo(() => ({
    ...appDefaultEnvVars,
    ...(selectedEnv?.envVars || {}),
  }), [appDefaultEnvVars, selectedEnv]);

  if (!isOpen) return null;

  const handleBrowse = async () => {
    if (isSSH) return;
    const dir = await window.electronAPI.dialog.openDirectory();
    if (dir) setDirectory(dir);
  };

  const handleCreate = () => {
    if (!directory.trim()) return;
    const env = Object.keys(sessionEnvVars).length > 0 ? sessionEnvVars : undefined;
    const args = sessionCliFlags.length > 0 ? sessionCliFlags : undefined;
    onCreate(directory.trim(), label.trim(), envId || undefined, env, args);
    setDirectory('');
    setLabel('');
    setEnvId('');
    setSessionEnvVars({});
    setSessionCliFlags([]);
    setCustomFlag('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && directory.trim()) handleCreate();
    if (e.key === 'Escape') onClose();
  };

  const dirName = (fullPath: string) => fullPath.split(/[\\/]/).pop() || fullPath;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-header">
          <span>New session</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          {environments.length > 1 && (
            <div className="form-group">
              <label className="form-label">Environment</label>
              <select
                className="form-input"
                value={envId}
                onChange={e => { setEnvId(e.target.value); setDirectory(''); }}
              >
                {environments.map(env => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.type})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Quick-pick from repos root */}
          {!isSSH && reposRoot && repoDirs.length > 0 && (
            <div className="form-group">
              <label className="form-label">Quick Pick</label>
              <div className="repo-picker">
                {repoDirs.map(dir => (
                  <button
                    key={dir}
                    className={`repo-picker-item ${directory === dir ? 'repo-picker-item--selected' : ''}`}
                    onClick={() => setDirectory(dir)}
                  >
                    {dirName(dir)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">
              {isSSH ? 'Remote Directory' : 'Directory'}
            </label>
            <div className="form-row">
              <input
                className="form-input"
                value={directory}
                onChange={e => setDirectory(e.target.value)}
                placeholder={isSSH ? '~/repos/my-project' : 'C:\\repos\\my-project'}
                autoFocus={!reposRoot}
              />
              {!isSSH && (
                <button className="form-btn" onClick={handleBrowse}>Browse</button>
              )}
            </div>
            {isSSH && selectedEnv?.config?.host && (
              <span className="form-hint">
                on {selectedEnv.config.username as string || 'root'}@{selectedEnv.config.host as string}
              </span>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Label (optional)</label>
            <input
              className="form-input"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Auto-generated from directory name"
            />
          </div>

          {/* Env var overrides */}
          <details className="form-group">
            <summary className="form-label" style={{ cursor: 'pointer' }}>
              Environment Variables
              {Object.keys(inheritedVars).length > 0 && (
                <span className="form-hint" style={{ display: 'inline', marginLeft: 8 }}>
                  ({Object.keys(inheritedVars).length} inherited)
                </span>
              )}
            </summary>
            <div style={{ marginTop: 8 }}>
              <EnvVarEditor
                vars={sessionEnvVars}
                onChange={setSessionEnvVars}
                inheritedVars={inheritedVars}
                compact
              />
            </div>
          </details>

          {/* CLI flags */}
          <details className="form-group">
            <summary className="form-label" style={{ cursor: 'pointer' }}>
              CLI Flags
              {defaultCliFlags.length > 0 && (
                <span className="form-hint" style={{ display: 'inline', marginLeft: 8 }}>
                  ({defaultCliFlags.length} from defaults)
                </span>
              )}
            </summary>
            <div style={{ marginTop: 8 }}>
              {defaultCliFlags.length > 0 && (
                <div style={{ marginBottom: 8, opacity: 0.5 }}>
                  <span className="form-hint">Inherited from defaults:</span>
                  {defaultCliFlags.map(f => (
                    <code key={f} className="cli-flag-code" style={{ marginLeft: 6 }}>{f}</code>
                  ))}
                </div>
              )}
              {sessionCliFlags.map(flag => (
                <div key={flag} className="cli-flag-custom">
                  <code className="cli-flag-code">{flag}</code>
                  <button
                    className="env-editor-btn env-editor-btn--remove"
                    onClick={() => setSessionCliFlags(prev => prev.filter(f => f !== flag))}
                  >&times;</button>
                </div>
              ))}
              <div className="form-row">
                <input
                  className="form-input"
                  value={customFlag}
                  onChange={e => setCustomFlag(e.target.value)}
                  placeholder="--flag-name"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      const f = customFlag.trim();
                      if (f && !sessionCliFlags.includes(f)) {
                        setSessionCliFlags(prev => [...prev, f]);
                        setCustomFlag('');
                      }
                    }
                  }}
                />
                <button className="form-btn" onClick={() => {
                  const f = customFlag.trim();
                  if (f && !sessionCliFlags.includes(f)) {
                    setSessionCliFlags(prev => [...prev, f]);
                    setCustomFlag('');
                  }
                }}>Add</button>
              </div>
            </div>
          </details>

          {/* Repos root config */}
          {!isSSH && (
            <div className="form-group">
              {!showRepoConfig && !reposRoot && (
                <button
                  className="form-link"
                  onClick={() => setShowRepoConfig(true)}
                >
                  Set repos directory for quick pick...
                </button>
              )}
              {!showRepoConfig && reposRoot && (
                <button
                  className="form-link"
                  onClick={() => { setShowRepoConfig(true); setReposRootInput(reposRoot); }}
                >
                  Change repos directory ({reposRoot})
                </button>
              )}
              {showRepoConfig && (
                <div className="form-row">
                  <input
                    className="form-input"
                    value={reposRootInput}
                    onChange={e => setReposRootInput(e.target.value)}
                    placeholder="C:\repo"
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); saveReposRoot(); } }}
                  />
                  <button className="form-btn" onClick={saveReposRoot}>Save</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button
            className="form-btn form-btn--primary"
            onClick={handleCreate}
            disabled={!directory.trim()}
          >
            Create Session
          </button>
        </div>
      </div>
    </div>
  );
}
