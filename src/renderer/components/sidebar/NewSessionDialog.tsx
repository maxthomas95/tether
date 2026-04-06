import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { EnvVarEditor } from '../EnvVarEditor';
import type { EnvironmentInfo, GitProviderInfo, GitRepoInfo, CloneProgressInfo } from '../../../shared/types';

type SourceTab = 'local' | 'clone' | 'gitea' | 'ado';

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

  // Tab state
  const [activeTab, setActiveTab] = useState<SourceTab>('local');
  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);

  // Clone state
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDestination, setCloneDestination] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState<CloneProgressInfo | null>(null);
  const [cloneError, setCloneError] = useState('');

  // Provider browse state
  const [providerSearchQuery, setProviderSearchQuery] = useState('');
  const [providerRepos, setProviderRepos] = useState<GitRepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load repos root, app default env vars, CLI flags, and git providers
  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI.config.getDefaultEnvVars?.()?.then(setAppDefaultEnvVars).catch(() => {});
    window.electronAPI.config.getDefaultCliFlags?.()?.then(setDefaultCliFlags).catch(() => {});
    window.electronAPI.config.get('reposRoot').then(val => {
      setReposRoot(val);
      if (val) {
        setReposRootInput(val);
        setCloneDestination(val);
        window.electronAPI.scanReposDir(val).then(setRepoDirs);
      }
    });
    window.electronAPI.gitProvider.list().then(setGitProviders).catch(() => {});
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

  // Set default provider when tab changes to a provider tab
  useEffect(() => {
    if (activeTab === 'gitea' || activeTab === 'ado') {
      const matching = gitProviders.filter(p => p.type === activeTab);
      if (matching.length > 0 && !selectedProviderId) {
        setSelectedProviderId(matching[0].id);
      }
    }
  }, [activeTab, gitProviders, selectedProviderId]);

  // Debounced repo search for provider tabs
  useEffect(() => {
    if (activeTab !== 'gitea' && activeTab !== 'ado') return;
    if (!selectedProviderId) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoadingRepos(true);
      window.electronAPI.gitProvider.listRepos(selectedProviderId, providerSearchQuery || undefined)
        .then(repos => {
          setProviderRepos(repos);
          setLoadingRepos(false);
        })
        .catch(() => {
          setProviderRepos([]);
          setLoadingRepos(false);
        });
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [activeTab, selectedProviderId, providerSearchQuery]);

  // Clone progress listener
  useEffect(() => {
    if (!isOpen) return;
    const unsub = window.electronAPI.git.onCloneProgress((info) => {
      setCloneProgress(info);
    });
    return unsub;
  }, [isOpen]);

  const saveReposRoot = useCallback(async () => {
    const val = reposRootInput.trim();
    if (val) {
      await window.electronAPI.config.set('reposRoot', val);
      setReposRoot(val);
      setCloneDestination(val);
      const dirs = await window.electronAPI.scanReposDir(val);
      setRepoDirs(dirs);
    }
    setShowRepoConfig(false);
  }, [reposRootInput]);

  const selectedEnv = environments.find(e => e.id === envId);
  const isSSH = selectedEnv?.type === 'ssh';

  const inheritedVars = useMemo(() => ({
    ...appDefaultEnvVars,
    ...(selectedEnv?.envVars || {}),
  }), [appDefaultEnvVars, selectedEnv]);

  // Derived repo name from clone URL
  const derivedRepoName = useMemo(() => {
    if (!cloneUrl) return '';
    const last = cloneUrl.split('/').pop() || '';
    return last.replace(/\.git$/, '');
  }, [cloneUrl]);

  const cloneFullPath = useMemo(() => {
    if (!cloneDestination || !derivedRepoName) return '';
    const sep = cloneDestination.includes('/') ? '/' : '\\';
    return `${cloneDestination}${sep}${derivedRepoName}`;
  }, [cloneDestination, derivedRepoName]);

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
    resetAndClose();
  };

  const handleClone = async () => {
    const url = activeTab === 'clone' ? cloneUrl.trim() : selectedRepo?.cloneUrl;
    if (!url || !cloneDestination.trim()) return;

    const repoName = activeTab === 'clone'
      ? derivedRepoName
      : (selectedRepo?.fullName.split('/').pop() || '');
    if (!repoName) return;

    const sep = cloneDestination.includes('/') ? '/' : '\\';
    const fullDest = `${cloneDestination.trim()}${sep}${repoName}`;

    setCloning(true);
    setCloneError('');
    setCloneProgress(null);

    try {
      const clonedPath = await window.electronAPI.git.clone(url, fullDest);
      const env = Object.keys(sessionEnvVars).length > 0 ? sessionEnvVars : undefined;
      const args = sessionCliFlags.length > 0 ? sessionCliFlags : undefined;
      onCreate(clonedPath, label.trim() || repoName, envId || undefined, env, args);
      resetAndClose();
    } catch (err: unknown) {
      setCloneError(err instanceof Error ? err.message : String(err));
      setCloning(false);
    }
  };

  const resetAndClose = () => {
    setDirectory('');
    setLabel('');
    setEnvId('');
    setSessionEnvVars({});
    setSessionCliFlags([]);
    setCustomFlag('');
    setActiveTab('local');
    setCloneUrl('');
    setCloneDestination(reposRoot || '');
    setCloning(false);
    setCloneProgress(null);
    setCloneError('');
    setProviderSearchQuery('');
    setProviderRepos([]);
    setSelectedRepo(null);
    setSelectedProviderId('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && activeTab === 'local' && directory.trim()) handleCreate();
    if (e.key === 'Escape') resetAndClose();
  };

  const dirName = (fullPath: string) => fullPath.split(/[\\/]/).pop() || fullPath;

  const hasGitea = gitProviders.some(p => p.type === 'gitea');
  const hasAdo = gitProviders.some(p => p.type === 'ado');
  const isProviderTab = activeTab === 'gitea' || activeTab === 'ado';
  const dialogClass = `dialog ${isProviderTab ? 'dialog--wide' : ''}`;

  const matchingProviders = gitProviders.filter(p => p.type === activeTab);

  return (
    <div className="dialog-overlay" onClick={resetAndClose}>
      <div className={dialogClass} onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-header">
          <span>New session</span>
          <button className="dialog-close" onClick={resetAndClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {/* Source tabs */}
          <div className="source-tabs">
            <button
              className={`source-tab ${activeTab === 'local' ? 'source-tab--active' : ''}`}
              onClick={() => setActiveTab('local')}
            >Local</button>
            <button
              className={`source-tab ${activeTab === 'clone' ? 'source-tab--active' : ''}`}
              onClick={() => setActiveTab('clone')}
            >Clone URL</button>
            {hasGitea && (
              <button
                className={`source-tab ${activeTab === 'gitea' ? 'source-tab--active' : ''}`}
                onClick={() => setActiveTab('gitea')}
              >Gitea</button>
            )}
            {hasAdo && (
              <button
                className={`source-tab ${activeTab === 'ado' ? 'source-tab--active' : ''}`}
                onClick={() => setActiveTab('ado')}
              >ADO</button>
            )}
          </div>

          {/* Environment selector (shared across tabs) */}
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

          {/* === LOCAL TAB === */}
          {activeTab === 'local' && (
            <>
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
                {isSSH && !!selectedEnv?.config?.host && (
                  <span className="form-hint">
                    on {String(selectedEnv.config.username || 'root')}@{String(selectedEnv.config.host)}
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
            </>
          )}

          {/* === CLONE URL TAB === */}
          {activeTab === 'clone' && (
            <>
              <div className="form-group">
                <label className="form-label">Git URL</label>
                <input
                  className="form-input"
                  value={cloneUrl}
                  onChange={e => setCloneUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  autoFocus
                  disabled={cloning}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Destination directory</label>
                <div className="form-row">
                  <input
                    className="form-input"
                    value={cloneDestination}
                    onChange={e => setCloneDestination(e.target.value)}
                    placeholder="C:\repo"
                    disabled={cloning}
                  />
                  <button className="form-btn" disabled={cloning} onClick={async () => {
                    const dir = await window.electronAPI.dialog.openDirectory();
                    if (dir) setCloneDestination(dir);
                  }}>Browse</button>
                </div>
                {cloneFullPath && (
                  <span className="form-hint">{cloneFullPath}</span>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Label (optional)</label>
                <input
                  className="form-input"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder={derivedRepoName || 'Auto-generated from repo name'}
                  disabled={cloning}
                />
              </div>

              {cloning && cloneProgress && (
                <div className="clone-progress">
                  <div className="clone-progress-label">{cloneProgress.message}</div>
                  <div className="clone-progress-bar">
                    <div className="clone-progress-fill" style={{ width: `${cloneProgress.percent}%` }} />
                  </div>
                </div>
              )}

              {cloneError && (
                <div className="clone-error">{cloneError}</div>
              )}
            </>
          )}

          {/* === PROVIDER TABS (Gitea / ADO) === */}
          {isProviderTab && (
            <>
              {matchingProviders.length > 1 && (
                <div className="form-group">
                  <label className="form-label">Provider</label>
                  <select
                    className="form-input"
                    value={selectedProviderId}
                    onChange={e => {
                      setSelectedProviderId(e.target.value);
                      setProviderRepos([]);
                      setSelectedRepo(null);
                      setProviderSearchQuery('');
                    }}
                    disabled={cloning}
                  >
                    {matchingProviders.map(p => (
                      <option key={p.id} value={p.id}>{p.name} ({p.baseUrl})</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Search repos</label>
                <input
                  className="form-input"
                  value={providerSearchQuery}
                  onChange={e => setProviderSearchQuery(e.target.value)}
                  placeholder="Search..."
                  autoFocus
                  disabled={cloning}
                />
              </div>

              <div className="form-group">
                {loadingRepos && <span className="form-hint">Loading...</span>}
                {!loadingRepos && providerRepos.length === 0 && selectedProviderId && (
                  <span className="form-hint">No repos found. Try a different search.</span>
                )}
                {providerRepos.length > 0 && (
                  <div className="repo-list">
                    {providerRepos.map(repo => (
                      <div
                        key={repo.cloneUrl}
                        className={`repo-list-item ${selectedRepo?.cloneUrl === repo.cloneUrl ? 'repo-list-item--selected' : ''}`}
                        onClick={() => {
                          setSelectedRepo(repo);
                          setCloneUrl(repo.cloneUrl);
                        }}
                      >
                        <div>
                          <span className="repo-list-item-name">{repo.fullName}</span>
                          {repo.isPrivate && <span className="repo-list-item-badge">private</span>}
                        </div>
                        {repo.description && (
                          <span className="repo-list-item-desc">{repo.description}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Destination directory</label>
                <div className="form-row">
                  <input
                    className="form-input"
                    value={cloneDestination}
                    onChange={e => setCloneDestination(e.target.value)}
                    placeholder="C:\repo"
                    disabled={cloning}
                  />
                  <button className="form-btn" disabled={cloning} onClick={async () => {
                    const dir = await window.electronAPI.dialog.openDirectory();
                    if (dir) setCloneDestination(dir);
                  }}>Browse</button>
                </div>
                {selectedRepo && cloneDestination && (
                  <span className="form-hint">
                    {cloneDestination}{cloneDestination.includes('/') ? '/' : '\\'}{selectedRepo.fullName.split('/').pop()}
                  </span>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Label (optional)</label>
                <input
                  className="form-input"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder={selectedRepo?.fullName.split('/').pop() || 'Auto-generated from repo name'}
                  disabled={cloning}
                />
              </div>

              {cloning && cloneProgress && (
                <div className="clone-progress">
                  <div className="clone-progress-label">{cloneProgress.message}</div>
                  <div className="clone-progress-bar">
                    <div className="clone-progress-fill" style={{ width: `${cloneProgress.percent}%` }} />
                  </div>
                </div>
              )}

              {cloneError && (
                <div className="clone-error">{cloneError}</div>
              )}
            </>
          )}
        </div>

        <div className="dialog-footer">
          <button className="form-btn" onClick={resetAndClose}>Cancel</button>
          {activeTab === 'local' ? (
            <button
              className="form-btn form-btn--primary"
              onClick={handleCreate}
              disabled={!directory.trim()}
            >
              Create Session
            </button>
          ) : (
            <button
              className="form-btn form-btn--primary"
              onClick={handleClone}
              disabled={
                cloning ||
                (activeTab === 'clone' ? (!cloneUrl.trim() || !cloneDestination.trim()) : !selectedRepo) ||
                !cloneDestination.trim()
              }
            >
              {cloning ? 'Cloning...' : 'Clone & Create Session'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
