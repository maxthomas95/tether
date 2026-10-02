import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import {
  MAX_RECIPE_NAME_LENGTH,
  MAX_RECIPE_SESSIONS,
  type PreparedWorkspaceRecipe,
  type WorkspaceRecipe,
  type WorkspaceRecipeFailure,
  type WorkspaceRecipeLaunchResult,
  type WorkspaceRecipeOpenPlan,
} from '../../shared/workspace-recipes';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { abbreviatePath } from '../utils/paths';
import '../styles/workspace-recipes.css';

interface WorkspaceRecipesDialogProps {
  sessions: SessionInfo[];
  environments: EnvironmentInfo[];
  launching: boolean;
  blocked?: boolean;
  onClose: () => void;
  onCapture: (name: string, sessionIds: string[]) => Promise<WorkspaceRecipe>;
  onLaunch: (plan: WorkspaceRecipeOpenPlan, previousSessionIds?: Array<string | null>) => Promise<WorkspaceRecipeLaunchResult>;
  onFinish: (plan: WorkspaceRecipeOpenPlan, result: WorkspaceRecipeLaunchResult) => void;
  onCancelLaunch: () => void;
}

type SaveMode = 'idle' | 'saving';
type LaunchState = 'idle' | 'preparing' | 'launching' | 'partial' | 'error';

interface OpenRow {
  selected: boolean;
  workingDir: string;
  environmentId: string;
  missingEnvironmentName?: string;
  disabledStarted?: boolean;
  error?: string;
}

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleString();
}

function localEnvironmentLabel(): string {
  return 'Local PC';
}

function environmentLabel(env: EnvironmentInfo | undefined): string {
  if (!env) return localEnvironmentLabel();
  if (env.type === 'local') return env.name;
  return `${env.type === 'ssh' ? 'SSH' : 'Coder'}: ${env.name}`;
}

function slotEnvironmentId(recipe: WorkspaceRecipe, index: number): string {
  return recipe.sessions[index]?.environmentId ?? '';
}

function getEnvironmentName(recipe: WorkspaceRecipe, index: number, environments: EnvironmentInfo[]): string | undefined {
  const id = slotEnvironmentId(recipe, index);
  if (!id) return undefined;
  return environments.find(env => env.id === id)?.name ?? id;
}

function initialRows(recipe: WorkspaceRecipe, environments: EnvironmentInfo[]): OpenRow[] {
  return recipe.sessions.map((slot, index) => {
    const environmentId = slot.environmentId ?? '';
    const known = !environmentId || environments.some(env => env.id === environmentId);
    return {
      selected: true,
      workingDir: slot.workingDir,
      environmentId,
      missingEnvironmentName: known ? undefined : getEnvironmentName(recipe, index, environments),
    };
  });
}

function selectionCount(rows: OpenRow[]): number {
  return rows.filter(row => row.selected && !row.disabledStarted).length;
}

function mergeFailures(rows: OpenRow[], failures: WorkspaceRecipeFailure[]): OpenRow[] {
  const byIndex = new Map(failures.map(failure => [failure.sessionIndex, failure.error]));
  return rows.map((row, index) => ({ ...row, error: byIndex.get(index) }));
}

function successfulCount(result: WorkspaceRecipeLaunchResult | null): number {
  return result?.sessionIds.filter(Boolean).length ?? 0;
}

export function WorkspaceRecipesDialog({
  sessions,
  environments,
  launching,
  blocked = false,
  onClose,
  onCapture,
  onLaunch,
  onFinish,
  onCancelLaunch,
}: Readonly<WorkspaceRecipesDialogProps>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const restoreFocusRef = useRef(true);
  useFocusTrap(dialogRef, !blocked, restoreFocusRef);

  const [recipes, setRecipes] = useState<WorkspaceRecipe[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveMode>('idle');
  const [saveOpen, setSaveOpen] = useState(false);
  const [recipeName, setRecipeName] = useState('');
  const [saveSessionIds, setSaveSessionIds] = useState<Set<string>>(() => new Set(sessions.length <= MAX_RECIPE_SESSIONS ? sessions.map(session => session.id) : []));
  const [rows, setRows] = useState<OpenRow[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>('idle');
  const [launchPlan, setLaunchPlan] = useState<WorkspaceRecipeOpenPlan | null>(null);
  const [launchResult, setLaunchResult] = useState<WorkspaceRecipeLaunchResult | null>(null);

  const busy = launching || loading || saving === 'saving' || launchState === 'preparing' || launchState === 'launching';
  const controlsDisabled = blocked || busy;
  const selectedRecipe = recipes.find(recipe => recipe.id === selectedId) ?? null;

  const envById = useMemo(() => new Map(environments.map(env => [env.id, env])), [environments]);

  const loadRecipes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.electronAPI.workspaceRecipes.list();
      if (!mountedRef.current) return;
      setRecipes(next);
      setSelectedId(prev => prev && next.some(recipe => recipe.id === prev) ? prev : next[0]?.id ?? null);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadRecipes();
    return () => { mountedRef.current = false; };
  }, [loadRecipes]);

  useEffect(() => {
    if (!selectedRecipe) {
      setRows([]);
      return;
    }
    setRows(initialRows(selectedRecipe, environments));
    setLaunchState('idle');
    setLaunchPlan(null);
    setLaunchResult(null);
  }, [selectedRecipe?.id, environments]);

  useEffect(() => {
    if (!saveOpen) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [saveOpen]);

  const close = useCallback(() => {
    if (blocked) return;
    if (launchState === 'launching' || launching) onCancelLaunch();
    onClose();
  }, [blocked, launchState, launching, onCancelLaunch, onClose]);

  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !blocked) {
      e.preventDefault();
      close();
    }
  }, [blocked, close]);

  const openSave = () => {
    setSaveOpen(true);
    setRecipeName('');
    setError(null);
    setSaveSessionIds(new Set(sessions.length <= MAX_RECIPE_SESSIONS ? sessions.map(session => session.id) : []));
  };

  const toggleSaveSession = (id: string) => {
    setSaveSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_RECIPE_SESSIONS) next.add(id);
      return next;
    });
  };

  const handleCapture = async () => {
    const name = recipeName.trim();
    const ids = Array.from(saveSessionIds);
    if (!name) {
      setError('Name this workspace before saving.');
      return;
    }
    if (name.length > MAX_RECIPE_NAME_LENGTH) {
      setError(`Workspace names can be at most ${MAX_RECIPE_NAME_LENGTH} characters.`);
      return;
    }
    if (ids.length < 1 || ids.length > MAX_RECIPE_SESSIONS) {
      setError(`Choose between 1 and ${MAX_RECIPE_SESSIONS} sessions to save.`);
      return;
    }
    setSaving('saving');
    setError(null);
    try {
      const recipe = await onCapture(name, ids);
      if (!mountedRef.current) return;
      setRecipes(prev => [recipe, ...prev.filter(item => item.id !== recipe.id)]);
      setSelectedId(recipe.id);
      setSaveOpen(false);
      setRecipeName('');
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSaving('idle');
    }
  };

  const handleRename = async (recipe: WorkspaceRecipe) => {
    const name = renameValue.trim();
    if (!name || name.length > MAX_RECIPE_NAME_LENGTH) {
      setError(`Use a workspace name between 1 and ${MAX_RECIPE_NAME_LENGTH} characters.`);
      return;
    }
    setError(null);
    try {
      const updated = await window.electronAPI.workspaceRecipes.rename(recipe.id, name);
      if (!mountedRef.current) return;
      setRecipes(prev => prev.map(item => item.id === recipe.id ? updated : item));
      setRenamingId(null);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (recipe: WorkspaceRecipe) => {
    setError(null);
    try {
      await window.electronAPI.workspaceRecipes.delete(recipe.id);
      if (!mountedRef.current) return;
      setRecipes(prev => prev.filter(item => item.id !== recipe.id));
      setSelectedId(prev => prev === recipe.id ? null : prev);
      setDeleteConfirmId(null);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateRow = (index: number, patch: Partial<OpenRow>) => {
    setRows(prev => prev.map((row, i) => i === index ? { ...row, ...patch, error: undefined } : row));
  };

  const prepareSelections = () => rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.selected && !row.disabledStarted)
    .map(({ row, index }) => ({
      sessionIndex: index,
      workingDir: row.workingDir.trim(),
      environmentId: row.environmentId || undefined,
    }));

  const startLaunch = async (previous?: WorkspaceRecipeLaunchResult) => {
    if (!selectedRecipe) return;
    const selections = prepareSelections();
    if (selections.length === 0) {
      setError('Choose at least one session to open.');
      return;
    }
    setError(null);
    setRows(prev => prev.map(row => ({ ...row, error: undefined })));
    setLaunchState('preparing');
    try {
      const prepared: PreparedWorkspaceRecipe = await window.electronAPI.workspaceRecipes.prepareOpen({ recipeId: selectedRecipe.id, selections });
      if (!mountedRef.current) return;
      if (!prepared.ok) {
        setRows(prev => mergeFailures(prev, prepared.failures));
        setLaunchState('error');
        return;
      }
      setLaunchPlan(prepared.plan);
      setLaunchState('launching');
      const result = await onLaunch(prepared.plan, previous?.sessionIds);
      if (!mountedRef.current) return;
      setLaunchResult(result);
      setRows(prev => prev.map((row, index) => ({
        ...row,
        disabledStarted: Boolean(result.sessionIds[index]) || row.disabledStarted,
        selected: result.sessionIds[index] ? false : row.selected,
        error: result.failures.find(failure => failure.sessionIndex === index)?.error,
      })));
      if (!result.cancelled && result.failures.length === 0) {
        restoreFocusRef.current = false;
        onFinish(prepared.plan, result);
      } else {
        setLaunchState('partial');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLaunchState('error');
    }
  };

  const finishPartial = () => {
    if (!launchPlan || !launchResult) return;
    restoreFocusRef.current = false;
    onFinish(launchPlan, launchResult);
  };

  const cancelLaunch = () => {
    onCancelLaunch();
    setLaunchState('partial');
  };

  const currentSessionRows = sessions.map(session => ({
    session,
    env: session.environmentId ? envById.get(session.environmentId) : undefined,
  }));

  return (
    <div className="dialog-overlay workspace-recipes-overlay" onClick={close} role="presentation">
      <div
        ref={dialogRef}
        className="dialog dialog--wide workspace-recipes-dialog"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        role="dialog"
        aria-modal={!blocked}
        aria-labelledby="workspace-recipes-title"
        aria-describedby="workspace-recipes-status"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <span id="workspace-recipes-title">Workspaces</span>
          <button className="dialog-close" aria-label="Close workspaces" onClick={close} disabled={blocked} type="button">&times;</button>
        </div>
        <div className="workspace-recipes-status" id="workspace-recipes-status" role="status" aria-live="polite">
          {blocked ? 'Vault is asking for access. Finish that prompt before changing workspace recipes.'
            : launchState === 'launching' || launching ? 'Starting selected sessions…'
            : loading ? 'Loading saved workspaces…'
            : `${recipes.length} saved workspace${recipes.length === 1 ? '' : 's'}.`}
        </div>
        {error && <div className="workspace-recipes-alert" role="alert">{error}</div>}
        <div className="workspace-recipes-grid">
          <aside className="workspace-recipes-list" aria-label="Saved workspaces">
            <button className="form-btn form-btn--primary workspace-recipes-save-btn" type="button" onClick={openSave} disabled={controlsDisabled || sessions.length === 0}>
              Save current workspace
            </button>
            {recipes.length === 0 && !loading ? (
              <div className="workspace-recipes-empty">
                <strong>No saved workspaces yet.</strong>
                <span>Capture the sessions you use together, then open fresh conversations from the recipe later.</span>
                <button className="form-btn" type="button" onClick={openSave} disabled={controlsDisabled || sessions.length === 0}>Save this workspace</button>
              </div>
            ) : (
              <ul className="workspace-recipes-items">
                {recipes.map(recipe => (
                  <li key={recipe.id} className={`workspace-recipes-item ${recipe.id === selectedId ? 'workspace-recipes-item--selected' : ''}`}>
                    <button type="button" className="workspace-recipes-item-main" onClick={() => setSelectedId(recipe.id)} disabled={controlsDisabled}>
                      <span className="workspace-recipes-item-name">{recipe.name}</span>
                      <span>{recipe.sessions.length} session{recipe.sessions.length === 1 ? '' : 's'} · {recipe.layout.mode}</span>
                      <span>Updated {formatDate(recipe.updatedAt)}</span>
                    </button>
                    {renamingId === recipe.id ? (
                      <div className="workspace-recipes-inline-edit">
                        <input value={renameValue} maxLength={MAX_RECIPE_NAME_LENGTH} onChange={e => setRenameValue(e.target.value)} aria-label="Workspace name" disabled={controlsDisabled} />
                        <button type="button" onClick={() => void handleRename(recipe)} disabled={controlsDisabled}>Save</button>
                        <button type="button" onClick={() => setRenamingId(null)} disabled={controlsDisabled}>Cancel</button>
                      </div>
                    ) : deleteConfirmId === recipe.id ? (
                      <div className="workspace-recipes-inline-edit workspace-recipes-delete-confirm">
                        <span>Delete this recipe?</span>
                        <button type="button" onClick={() => void handleDelete(recipe)} disabled={controlsDisabled}>Delete</button>
                        <button type="button" onClick={() => setDeleteConfirmId(null)} disabled={controlsDisabled}>Keep</button>
                      </div>
                    ) : (
                      <div className="workspace-recipes-item-actions">
                        <button type="button" onClick={() => { setRenamingId(recipe.id); setRenameValue(recipe.name); }} disabled={controlsDisabled}>Rename</button>
                        <button type="button" onClick={() => setDeleteConfirmId(recipe.id)} disabled={controlsDisabled}>Delete</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="workspace-recipes-detail">
            {saveOpen ? (
              <div className="workspace-recipes-panel" aria-label="Save current workspace">
                <h3>Save current workspace</h3>
                <label className="workspace-recipes-field">
                  <span>Name</span>
                  <input ref={nameInputRef} value={recipeName} maxLength={MAX_RECIPE_NAME_LENGTH} onChange={e => setRecipeName(e.target.value)} disabled={controlsDisabled} placeholder="Daily review" />
                </label>
                <div className="workspace-recipes-selection-header">
                  <span>{saveSessionIds.size}/{Math.min(sessions.length, MAX_RECIPE_SESSIONS)} selected</span>
                  <button type="button" onClick={() => setSaveSessionIds(new Set(sessions.slice(0, MAX_RECIPE_SESSIONS).map(session => session.id)))} disabled={controlsDisabled}>Select all</button>
                  <button type="button" onClick={() => setSaveSessionIds(new Set())} disabled={controlsDisabled}>Clear</button>
                </div>
                <ul className="workspace-recipes-current-list">
                  {currentSessionRows.map(({ session, env }) => (
                    <li key={session.id}>
                      <label>
                        <input type="checkbox" checked={saveSessionIds.has(session.id)} onChange={() => toggleSaveSession(session.id)} disabled={controlsDisabled || (!saveSessionIds.has(session.id) && saveSessionIds.size >= MAX_RECIPE_SESSIONS)} />
                        <span>
                          <strong>{session.label}</strong>
                          <small>{session.cliTool ?? 'claude'} · {environmentLabel(env)} · {abbreviatePath(session.workingDir)}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="workspace-recipes-actions">
                  <button className="form-btn" type="button" onClick={() => setSaveOpen(false)} disabled={controlsDisabled}>Cancel</button>
                  <button className="form-btn form-btn--primary" type="button" onClick={() => void handleCapture()} disabled={controlsDisabled}>Save workspace</button>
                </div>
              </div>
            ) : selectedRecipe ? (
              <div className="workspace-recipes-panel" aria-label="Open saved workspace">
                <div className="workspace-recipes-detail-heading">
                  <div>
                    <h3>{selectedRecipe.name}</h3>
                    <p>{selectedRecipe.sessions.length} session{selectedRecipe.sessions.length === 1 ? '' : 's'} · {selectedRecipe.layout.mode} layout · Opens as fresh conversations.</p>
                  </div>
                  {launchResult && <span className="workspace-recipes-progress">{successfulCount(launchResult)} started</span>}
                </div>
                <div className="workspace-recipes-slots" role="group" aria-label="Sessions to open">
                  {selectedRecipe.sessions.map((slot, index) => {
                    const row = rows[index] ?? { selected: false, workingDir: slot.workingDir, environmentId: slot.environmentId ?? '' };
                    const knownEnv = row.environmentId ? envById.get(row.environmentId) : undefined;
                    const missing = row.environmentId && !knownEnv;
                    return (
                      <div key={`${selectedRecipe.id}-${index}`} className={`workspace-recipes-slot ${row.disabledStarted ? 'workspace-recipes-slot--started' : ''}`}>
                        <label className="workspace-recipes-slot-check">
                          <input type="checkbox" checked={row.selected} disabled={controlsDisabled || row.disabledStarted} onChange={e => updateRow(index, { selected: e.target.checked })} />
                          <span>{slot.label}</span>
                        </label>
                        <div className="workspace-recipes-slot-meta">{slot.cliTool}{slot.helmEnabled ? ' · Helm' : ''}</div>
                        <label className="workspace-recipes-field">
                          <span>{slot.environmentId && envById.get(slot.environmentId)?.type === 'coder' ? 'Coder workspace' : 'Working directory'}</span>
                          <input value={row.workingDir} onChange={e => updateRow(index, { workingDir: e.target.value })} disabled={controlsDisabled || row.disabledStarted} />
                        </label>
                        <label className="workspace-recipes-field">
                          <span>Environment</span>
                          <select value={row.environmentId} onChange={e => updateRow(index, { environmentId: e.target.value, missingEnvironmentName: undefined })} disabled={controlsDisabled || row.disabledStarted}>
                            <option value="">Local PC</option>
                            {environments.map(env => <option key={env.id} value={env.id}>{environmentLabel(env)}</option>)}
                            {missing && <option value={row.environmentId}>Missing: {row.missingEnvironmentName ?? row.environmentId}</option>}
                          </select>
                        </label>
                        {missing && <div className="workspace-recipes-warning">Saved environment is missing. Choose another target before opening.</div>}
                        {row.disabledStarted && <div className="workspace-recipes-started">Started in this launch.</div>}
                        {row.error && <div className="workspace-recipes-row-error" role="alert">{row.error}</div>}
                      </div>
                    );
                  })}
                </div>
                <div className="workspace-recipes-actions">
                  {launchState === 'launching' || launching ? <button className="form-btn" type="button" onClick={cancelLaunch}>Cancel remaining</button> : null}
                  {launchState === 'partial' && launchResult ? <button className="form-btn" type="button" onClick={() => void startLaunch(launchResult)} disabled={controlsDisabled || selectionCount(rows) === 0}>Start remaining selected</button> : null}
                  {launchState === 'partial' && launchResult && successfulCount(launchResult) > 0 ? <button className="form-btn form-btn--primary" type="button" onClick={finishPartial}>Show started sessions</button> : null}
                  <button className="form-btn form-btn--primary" type="button" onClick={() => void startLaunch()} disabled={controlsDisabled || selectionCount(rows) === 0}>Open selected sessions</button>
                </div>
              </div>
            ) : (
              <div className="workspace-recipes-panel workspace-recipes-placeholder">
                <h3>Pick a saved workspace</h3>
                <p>Saved workspaces reopen the shape of your work without stopping the sessions you already have running.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
