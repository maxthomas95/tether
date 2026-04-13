import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { EnvVarEditor } from '../EnvVarEditor';
import type { EnvironmentInfo, LaunchProfileInfo, GitProviderInfo, GitRepoInfo, CloneProgressInfo, CoderWorkspace, CliToolId } from '../../../shared/types';
import { CLI_TOOL_REGISTRY } from '../../../shared/cli-tools';
import type { CliToolDef } from '../../../shared/cli-tools';

type CliFlagsPerTool = Partial<Record<CliToolId, string[]>>;

type SourceTab = 'local' | 'clone' | 'gitea' | 'ado';

interface CoderCloneTargetProps {
  envId: string;
  workspaces: CoderWorkspace[];
  loadingCoder: boolean;
  coderError: string;
  refresh: () => void;
  workspace: string;
  setWorkspace: (v: string) => void;
  clonePath: string;
  setClonePath: (v: string) => void;
  fullPath: string;
  disabled: boolean;
}

function CoderCloneTarget({
  envId,
  workspaces,
  loadingCoder,
  coderError,
  refresh,
  workspace,
  setWorkspace,
  clonePath,
  setClonePath,
  fullPath,
  disabled,
}: CoderCloneTargetProps) {
  return (
    <>
      <div className="form-group">
        <label className="form-label">Coder workspace</label>
        <div className="form-row">
          <select
            className="form-input"
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
            disabled={disabled || loadingCoder || workspaces.length === 0}
          >
            <option value="">
              {loadingCoder
                ? 'Loading workspaces...'
                : workspaces.length === 0
                  ? 'No workspaces found'
                  : 'Select a workspace'}
            </option>
            {workspaces.map(ws => (
              <option key={`${ws.owner}/${ws.name}`} value={ws.name}>
                {ws.owner}/{ws.name} ({ws.status})
              </option>
            ))}
          </select>
          <button className="form-btn" onClick={refresh} disabled={disabled || loadingCoder || !envId}>
            Refresh
          </button>
        </div>
        {coderError && (
          <span className="form-hint" style={{ color: 'var(--status-dead)' }}>{coderError}</span>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Clone into (path inside workspace)</label>
        <input
          className="form-input"
          value={clonePath}
          onChange={e => setClonePath(e.target.value)}
          placeholder="~"
          disabled={disabled}
        />
        {fullPath && (
          <span className="form-hint">Will clone to <code>{fullPath}</code> inside the workspace.</span>
        )}
      </div>
    </>
  );
}

interface NewSessionDialogProps {
  isOpen: boolean;
  environments: EnvironmentInfo[];
  profiles: LaunchProfileInfo[];
  onClose: () => void;
  onCreate: (workingDir: string, label: string, environmentId?: string, env?: Record<string, string>, cliArgs?: string[], resumeClaudeSessionId?: string, profileId?: string, cloneUrl?: string, cliTool?: CliToolId, customCliBinary?: string, disabledInheritedFlags?: string[]) => void;
}

export function NewSessionDialog({ isOpen, environments, profiles, onClose, onCreate }: NewSessionDialogProps) {
  const [envId, setEnvId] = useState<string>('');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');
  const [reposRoot, setReposRoot] = useState<string | null>(null);
  const [repoDirs, setRepoDirs] = useState<string[]>([]);
  const [showRepoConfig, setShowRepoConfig] = useState(false);
  const [reposRootInput, setReposRootInput] = useState('');
  const [sessionEnvVars, setSessionEnvVars] = useState<Record<string, string>>({});
  const [appDefaultEnvVars, setAppDefaultEnvVars] = useState<Record<string, string>>({});
  const [defaultCliFlagsPerTool, setDefaultCliFlagsPerTool] = useState<CliFlagsPerTool>({});
  const [disabledFlags, setDisabledFlags] = useState<Set<string>>(new Set());
  const [sessionCliFlags, setSessionCliFlags] = useState<string[]>([]);
  const [customFlag, setCustomFlag] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [cliTool, setCliTool] = useState<CliToolId>('claude');
  const [customBinary, setCustomBinary] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<SourceTab>('local');
  const [gitProviders, setGitProviders] = useState<GitProviderInfo[]>([]);

  // Clone state
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDestination, setCloneDestination] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState<CloneProgressInfo | null>(null);
  const [cloneError, setCloneError] = useState('');

  // Coder-specific clone target: workspace to clone into + path template (supports `~`)
  const [coderCloneWorkspace, setCoderCloneWorkspace] = useState('');
  const [coderClonePath, setCoderClonePath] = useState('~');

  // Provider browse state
  const [providerSearchQuery, setProviderSearchQuery] = useState('');
  const [providerRepos, setProviderRepos] = useState<GitRepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Coder workspace state
  const [coderWorkspaces, setCoderWorkspaces] = useState<CoderWorkspace[]>([]);
  const [loadingCoder, setLoadingCoder] = useState(false);
  const [coderError, setCoderError] = useState('');

  // Load repos root, app default env vars, CLI flags, and git providers
  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI.config.getDefaultEnvVars?.()?.then(setAppDefaultEnvVars).catch(() => {});
    window.electronAPI.config.getDefaultCliFlagsPerTool?.()?.then(v => setDefaultCliFlagsPerTool(v || {})).catch(() => {});
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

  // Pre-select default profile when dialog opens
  useEffect(() => {
    if (isOpen && profiles.length > 0) {
      const defaultProfile = profiles.find(p => p.isDefault);
      setProfileId(defaultProfile ? defaultProfile.id : null);
    }
  }, [isOpen, profiles]);

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
      setRepoError('');
      window.electronAPI.gitProvider.listRepos(selectedProviderId, providerSearchQuery || undefined)
        .then(repos => {
          setProviderRepos(repos);
          setLoadingRepos(false);
        })
        .catch((err: unknown) => {
          setProviderRepos([]);
          setRepoError(err instanceof Error ? err.message : String(err));
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
  const isCoder = selectedEnv?.type === 'coder';
  const selectedProfile = profiles.find(p => p.id === profileId);

  // Effective default flags for the selected CLI tool
  const effectiveDefaultFlags = useMemo(
    () => defaultCliFlagsPerTool[cliTool] || [],
    [defaultCliFlagsPerTool, cliTool],
  );

  // Reset disabled flags when CLI tool changes (different tool = different defaults)
  useEffect(() => { setDisabledFlags(new Set()); }, [cliTool]);

  const fetchCoderWorkspaces = useCallback((id: string) => {
    setLoadingCoder(true);
    setCoderError('');
    window.electronAPI.coder.listWorkspaces(id)
      .then(ws => {
        setCoderWorkspaces(ws);
        setLoadingCoder(false);
      })
      .catch((err: unknown) => {
        setCoderWorkspaces([]);
        setCoderError(err instanceof Error ? err.message : String(err));
        setLoadingCoder(false);
      });
  }, []);

  // Load Coder workspaces when a Coder env is selected
  useEffect(() => {
    if (!isOpen || !isCoder || !envId) {
      setCoderWorkspaces([]);
      setCoderError('');
      return;
    }
    fetchCoderWorkspaces(envId);
  }, [isOpen, isCoder, envId, fetchCoderWorkspaces]);

  const inheritedVars = useMemo(() => ({
    ...appDefaultEnvVars,
    ...(selectedEnv?.envVars || {}),
    ...(selectedProfile?.envVars || {}),
  }), [appDefaultEnvVars, selectedEnv, selectedProfile]);

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

  // For Coder: joined "<parentPath>/<repoName>" inside the workspace.
  const coderCloneFullPath = useMemo(() => {
    const repoName = activeTab === 'clone'
      ? derivedRepoName
      : (selectedRepo?.fullName.split('/').pop() || '');
    if (!repoName) return '';
    const parent = coderClonePath.trim() || '~';
    const trimmed = parent.endsWith('/') ? parent.slice(0, -1) : parent;
    return `${trimmed}/${repoName}`;
  }, [activeTab, derivedRepoName, selectedRepo, coderClonePath]);

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
    const disabled = disabledFlags.size > 0 ? Array.from(disabledFlags) : undefined;
    onCreate(directory.trim(), label.trim(), envId || undefined, env, args, undefined, profileId || undefined, undefined, cliTool, cliTool === 'custom' ? customBinary : undefined, disabled);
    resetAndClose();
  };

  const handleClone = async () => {
    const url = activeTab === 'clone' ? cloneUrl.trim() : selectedRepo?.cloneUrl;
    if (!url) return;

    const repoName = activeTab === 'clone'
      ? derivedRepoName
      : (selectedRepo?.fullName.split('/').pop() || '');
    if (!repoName) return;

    setCloning(true);
    setCloneError('');
    setCloneProgress(null);

    try {
      if (isCoder) {
        if (!coderCloneWorkspace || !envId) {
          setCloneError('Pick a Coder workspace to clone into.');
          setCloning(false);
          return;
        }
        const destInside = coderCloneFullPath;
        const env = Object.keys(sessionEnvVars).length > 0 ? sessionEnvVars : undefined;
        const args = sessionCliFlags.length > 0 ? sessionCliFlags : undefined;
        // Encode workspace + target subdir so CoderTransport runs
        // `git clone <url> <subdir> && cd <subdir> && claude` inside the
        // workspace PTY. All clone output streams to the terminal.
        const disabled = disabledFlags.size > 0 ? Array.from(disabledFlags) : undefined;
        onCreate(`${coderCloneWorkspace}::${destInside}`, label.trim() || repoName, envId, env, args, undefined, profileId || undefined, url, cliTool, cliTool === 'custom' ? customBinary : undefined, disabled);
        resetAndClose();
        return;
      }

      if (!cloneDestination.trim()) {
        setCloneError('Destination directory is required.');
        setCloning(false);
        return;
      }
      const sep = cloneDestination.includes('/') ? '/' : '\\';
      const fullDest = `${cloneDestination.trim()}${sep}${repoName}`;
      const clonedPath = await window.electronAPI.git.clone(url, fullDest);
      const env = Object.keys(sessionEnvVars).length > 0 ? sessionEnvVars : undefined;
      const args = sessionCliFlags.length > 0 ? sessionCliFlags : undefined;
      const disabled = disabledFlags.size > 0 ? Array.from(disabledFlags) : undefined;
      onCreate(clonedPath, label.trim() || repoName, envId || undefined, env, args, undefined, profileId || undefined, undefined, cliTool, cliTool === 'custom' ? customBinary : undefined, disabled);
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
    setRepoError('');
    setProfileId(null);
    setCoderCloneWorkspace('');
    setCoderClonePath('~');
    setCliTool('claude');
    setCustomBinary('');
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

          {/* CLI tool selector */}
          <div className="form-group">
            <label className="form-label">CLI Tool</label>
            <select
              className="form-input"
              value={cliTool}
              onChange={e => setCliTool(e.target.value as CliToolId)}
            >
              {Object.values(CLI_TOOL_REGISTRY).map((tool: CliToolDef) => (
                <option key={tool.id} value={tool.id}>{tool.displayName}</option>
              ))}
            </select>
          </div>

          {cliTool === 'custom' && (
            <div className="form-group">
              <label className="form-label">Binary Name</label>
              <input
                className="form-input"
                value={customBinary}
                onChange={e => setCustomBinary(e.target.value)}
                placeholder="my-cli"
              />
              <span className="form-hint">
                Name or path of the CLI binary to run.
              </span>
            </div>
          )}

          {/* Profile picker */}
          {profiles.length > 0 && (
            <div className="form-group">
              <label className="form-label">Profile</label>
              <div className="repo-picker">
                <button
                  className={`repo-picker-item ${profileId === null ? 'repo-picker-item--selected' : ''}`}
                  onClick={() => setProfileId(null)}
                >
                  None
                </button>
                {profiles.map(p => (
                  <button
                    key={p.id}
                    className={`repo-picker-item ${profileId === p.id ? 'repo-picker-item--selected' : ''}`}
                    onClick={() => setProfileId(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* === LOCAL TAB === */}
          {activeTab === 'local' && (
            <>
              {!isSSH && !isCoder && reposRoot && repoDirs.length > 0 && (
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

              {isCoder ? (
                <div className="form-group">
                  <label className="form-label">Workspace</label>
                  <div className="form-row">
                    <select
                      className="form-input"
                      value={directory}
                      onChange={e => setDirectory(e.target.value)}
                      disabled={loadingCoder || coderWorkspaces.length === 0}
                    >
                      <option value="">
                        {loadingCoder
                          ? 'Loading workspaces...'
                          : coderWorkspaces.length === 0
                            ? 'No workspaces found'
                            : 'Select a workspace'}
                      </option>
                      {coderWorkspaces.map(ws => (
                        <option key={`${ws.owner}/${ws.name}`} value={ws.name}>
                          {ws.owner}/{ws.name} ({ws.status})
                        </option>
                      ))}
                    </select>
                    <button
                      className="form-btn"
                      onClick={() => envId && fetchCoderWorkspaces(envId)}
                      disabled={loadingCoder}
                    >
                      Refresh
                    </button>
                  </div>
                  {coderError && (
                    <span className="form-hint" style={{ color: 'var(--status-dead)' }}>
                      {coderError}
                    </span>
                  )}
                  {!coderError && (
                    <span className="form-hint">
                      Workspace must be running. Start it from the Coder UI if stopped.
                    </span>
                  )}
                </div>
              ) : (
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
              )}

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
                  {effectiveDefaultFlags.length > 0 && (
                    <span className="form-hint" style={{ display: 'inline', marginLeft: 8 }}>
                      ({effectiveDefaultFlags.length} from defaults)
                    </span>
                  )}
                </summary>
                <div style={{ marginTop: 8 }}>
                  {effectiveDefaultFlags.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <span className="form-hint">Inherited from defaults (uncheck to disable):</span>
                      {effectiveDefaultFlags.map(f => (
                        <label key={f} className="form-radio-label" style={{ marginTop: 4, opacity: disabledFlags.has(f) ? 0.4 : 0.7 }}>
                          <input
                            type="checkbox"
                            checked={!disabledFlags.has(f)}
                            onChange={() => setDisabledFlags(prev => {
                              const next = new Set(prev);
                              next.has(f) ? next.delete(f) : next.add(f);
                              return next;
                            })}
                          />
                          <code className="cli-flag-code">{f}</code>
                        </label>
                      ))}
                    </div>
                  )}
                  {selectedProfile && selectedProfile.cliFlags.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <span className="form-hint">From profile (uncheck to disable):</span>
                      {selectedProfile.cliFlags.map(f => (
                        <label key={`p-${f}`} className="form-radio-label" style={{ marginTop: 4, opacity: disabledFlags.has(f) ? 0.4 : 0.7 }}>
                          <input
                            type="checkbox"
                            checked={!disabledFlags.has(f)}
                            onChange={() => setDisabledFlags(prev => {
                              const next = new Set(prev);
                              next.has(f) ? next.delete(f) : next.add(f);
                              return next;
                            })}
                          />
                          <code className="cli-flag-code">{f}</code>
                        </label>
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
              {!isSSH && !isCoder && (
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

              {isCoder ? (
                <CoderCloneTarget
                  envId={envId}
                  workspaces={coderWorkspaces}
                  loadingCoder={loadingCoder}
                  coderError={coderError}
                  refresh={() => envId && fetchCoderWorkspaces(envId)}
                  workspace={coderCloneWorkspace}
                  setWorkspace={setCoderCloneWorkspace}
                  clonePath={coderClonePath}
                  setClonePath={setCoderClonePath}
                  fullPath={coderCloneFullPath}
                  disabled={cloning}
                />
              ) : (
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
              )}

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
                {!loadingRepos && repoError && (
                  <span className="clone-error">{repoError}</span>
                )}
                {!loadingRepos && !repoError && providerRepos.length === 0 && selectedProviderId && (
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

              {isCoder ? (
                <CoderCloneTarget
                  envId={envId}
                  workspaces={coderWorkspaces}
                  loadingCoder={loadingCoder}
                  coderError={coderError}
                  refresh={() => envId && fetchCoderWorkspaces(envId)}
                  workspace={coderCloneWorkspace}
                  setWorkspace={setCoderCloneWorkspace}
                  clonePath={coderClonePath}
                  setClonePath={setCoderClonePath}
                  fullPath={coderCloneFullPath}
                  disabled={cloning}
                />
              ) : (
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
              )}

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
              disabled={(() => {
                if (cloning) return true;
                if (activeTab === 'clone' && !cloneUrl.trim()) return true;
                if (isProviderTab && !selectedRepo) return true;
                if (isCoder) return !coderCloneWorkspace || !coderClonePath.trim();
                return !cloneDestination.trim();
              })()}
            >
              {cloning ? 'Cloning...' : 'Clone & Create Session'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
