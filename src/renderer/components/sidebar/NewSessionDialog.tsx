import { useState, useEffect } from 'react';
import type { EnvironmentInfo } from '../../../shared/types';

interface NewSessionDialogProps {
  isOpen: boolean;
  environments: EnvironmentInfo[];
  onClose: () => void;
  onCreate: (workingDir: string, label: string, environmentId?: string) => void;
}

export function NewSessionDialog({ isOpen, environments, onClose, onCreate }: NewSessionDialogProps) {
  const [envId, setEnvId] = useState<string>('');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');

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

  if (!isOpen) return null;

  const selectedEnv = environments.find(e => e.id === envId);
  const isSSH = selectedEnv?.type === 'ssh';

  const handleBrowse = async () => {
    if (isSSH) return; // No local browse for SSH
    const dir = await window.electronAPI.dialog.openDirectory();
    if (dir) setDirectory(dir);
  };

  const handleCreate = () => {
    if (!directory.trim()) return;
    onCreate(directory.trim(), label.trim(), envId || undefined);
    setDirectory('');
    setLabel('');
    setEnvId('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && directory.trim()) handleCreate();
    if (e.key === 'Escape') onClose();
  };

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
                autoFocus
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
