import { useEffect, useState, useCallback } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { cleanIdentity, VAULT_REF_PREFIX } from '../utils/vault-path';

interface VaultPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the selected `vault://mount/path#field` reference. */
  onSelect: (ref: string) => void;
}

// Character-by-character trims — avoids the ReDoS surface area of
// quantified regex patterns on untrusted path fragments.
function trimLeadingSlash(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === '/') i++;
  return i === 0 ? s : s.slice(i);
}

function trimTrailingSlash(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return end === s.length ? s : s.slice(0, end);
}

function joinPath(base: string, segment: string): string {
  const cleanBase = trimTrailingSlash(base);
  const cleanSeg = trimTrailingSlash(trimLeadingSlash(segment));
  if (!cleanBase) return cleanSeg;
  if (!cleanSeg) return cleanBase;
  return `${cleanBase}/${cleanSeg}`;
}

function isFolderKey(key: string): boolean {
  return key.endsWith('/');
}

/**
 * Browse the current user's Vault folder and pick a secret + field.
 *
 * The UI roots at `<mount>/<identity>/` as a *convenience* — Vault policy is
 * the real access boundary. `listKeys` 404s are treated as "empty folder" so
 * permission-scoped users see a clean tree even if peers write siblings.
 */
export function VaultPickerDialog({ isOpen, onClose, onSelect }: Readonly<VaultPickerDialogProps>) {
  const [mount, setMount] = useState<string>('secret');
  const [identity, setIdentity] = useState<string>('');
  const [loggedIn, setLoggedIn] = useState<boolean>(false);

  // Path relative to mount, e.g. "mathomas@uwcu.org/tether/ssh".
  const [currentPath, setCurrentPath] = useState<string>('');
  const [rootPath, setRootPath] = useState<string>('');
  const [entries, setEntries] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [listError, setListError] = useState<string | null>(null);

  // When a leaf secret is selected, we load its field names.
  const [selectedSecretPath, setSelectedSecretPath] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState<boolean>(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  // Fetch vault config + status when the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    Promise.all([
      window.electronAPI.vault.getConfig().catch(() => null),
      window.electronAPI.vault.status().catch(() => null),
    ]).then(([cfg, status]) => {
      if (cancelled) return;
      const m = cfg?.mount || 'secret';
      const id = cleanIdentity(status?.identity);
      const root = id ? `${id}/` : '';
      setMount(m);
      setIdentity(id);
      setLoggedIn(!!status?.loggedIn);
      setRootPath(root);
      setCurrentPath(root);
      setSelectedSecretPath(null);
      setFields([]);
      setFieldsError(null);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  const loadEntries = useCallback(async (path: string) => {
    setListLoading(true);
    setListError(null);
    try {
      const keys = await window.electronAPI.vault.listKeys(mount, path);
      setEntries(keys);
    } catch (err) {
      setEntries([]);
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  }, [mount]);

  useEffect(() => {
    if (!isOpen || !loggedIn) return;
    loadEntries(currentPath);
  }, [isOpen, loggedIn, currentPath, loadEntries]);

  const enterFolder = (key: string) => {
    // key always ends with "/"
    setSelectedSecretPath(null);
    setFields([]);
    setCurrentPath(joinPath(currentPath, key));
  };

  const selectSecret = async (key: string) => {
    const path = joinPath(currentPath, key);
    setSelectedSecretPath(path);
    setFields([]);
    setFieldsError(null);
    setFieldsLoading(true);
    try {
      const f = await window.electronAPI.vault.listFields(mount, path);
      setFields(f);
      if (f.length === 0) setFieldsError('This secret has no fields.');
    } catch (err) {
      setFieldsError(err instanceof Error ? err.message : String(err));
    } finally {
      setFieldsLoading(false);
    }
  };

  const pickField = (field: string) => {
    if (!selectedSecretPath) return;
    const ref = `${VAULT_REF_PREFIX}${mount}/${selectedSecretPath}#${field}`;
    onSelect(ref);
    onClose();
  };

  const canGoUp = currentPath.length > rootPath.length;
  const goUp = () => {
    if (!canGoUp) return;
    const trimmed = trimTrailingSlash(currentPath);
    const lastSlash = trimmed.lastIndexOf('/');
    const next = lastSlash >= 0 ? `${trimmed.slice(0, lastSlash)}/` : '';
    // Never go above the user's root folder.
    setSelectedSecretPath(null);
    setFields([]);
    setCurrentPath(next.length < rootPath.length ? rootPath : next);
  };

  useEscapeKey(onClose, isOpen);
  if (!isOpen) return null;

  const folders = entries.filter(isFolderKey);
  const secrets = entries.filter(k => !isFolderKey(k));

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" aria-modal="true" aria-label="Browse Vault">
        <div className="dialog-header">
          <span>Browse Vault</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {!loggedIn && (
            <p className="form-hint" style={{ color: 'var(--status-dead)' }}>
              Not logged in to Vault. Open Settings &rarr; Vault to log in first.
            </p>
          )}

          {loggedIn && (
            <>
              <p className="form-hint" style={{ marginBottom: 8 }}>
                Browsing <code>{mount}/{currentPath || '/'}</code>
                {identity ? <> &mdash; scoped to your folder</> : null}
              </p>

              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button className="form-btn" onClick={goUp} disabled={!canGoUp}>
                  &larr; Up
                </button>
                <button className="form-btn" onClick={() => loadEntries(currentPath)}>
                  Refresh
                </button>
              </div>

              {listLoading && <p className="form-hint">Loading&hellip;</p>}
              {listError && (
                <p className="form-hint" style={{ color: 'var(--status-dead)' }}>
                  {listError}
                </p>
              )}

              {!listLoading && !listError && entries.length === 0 && (
                <p className="form-hint" style={{ fontStyle: 'italic' }}>
                  This folder is empty. Store a secret here first via the "Vault"
                  button on a sensitive field.
                </p>
              )}

              {folders.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {folders.map(key => (
                    <button
                      key={key}
                      type="button"
                      className="env-editor-preset-item vault-picker-row"
                      onClick={() => enterFolder(key)}
                    >
                      <span className="env-editor-preset-key">&#128193; {trimTrailingSlash(key)}</span>
                      <span className="env-editor-preset-label">folder</span>
                    </button>
                  ))}
                </div>
              )}

              {secrets.length > 0 && (
                <div>
                  {secrets.map(key => {
                    const secretPath = joinPath(currentPath, key);
                    const isSelected = selectedSecretPath === secretPath;
                    return (
                      <div key={key}>
                        <button
                          type="button"
                          className="env-editor-preset-item vault-picker-row"
                          onClick={() => selectSecret(key)}
                          style={{
                            background: isSelected ? 'var(--bg-tertiary)' : undefined,
                          }}
                        >
                          <span className="env-editor-preset-key">&#128273; {key}</span>
                          <span className="env-editor-preset-label">secret</span>
                        </button>

                        {isSelected && (
                          <div style={{ marginLeft: 20, marginTop: 4, marginBottom: 8 }}>
                            {fieldsLoading && <p className="form-hint">Loading fields&hellip;</p>}
                            {fieldsError && (
                              <p className="form-hint" style={{ color: 'var(--status-dead)' }}>
                                {fieldsError}
                              </p>
                            )}
                            {fields.map(f => (
                              <button
                                key={f}
                                type="button"
                                className="env-editor-preset-item vault-picker-row"
                                onClick={() => pickField(f)}
                              >
                                <span className="env-editor-preset-key">#{f}</span>
                                <span className="env-editor-preset-label">use this field</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
