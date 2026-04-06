import { useState } from 'react';
import { EnvVarEditor } from '../EnvVarEditor';
import type { EnvironmentType } from '../../../shared/types';

interface NewEnvironmentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: EnvironmentType, config: Record<string, unknown>, envVars: Record<string, string>) => void;
}

export function NewEnvironmentDialog({ isOpen, onClose, onCreate }: NewEnvironmentDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvironmentType>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [password, setPassword] = useState('');
  const [authMethod, setAuthMethod] = useState<'agent' | 'key' | 'password'>('agent');
  const [defaultDir, setDefaultDir] = useState('~');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});

  if (!isOpen) return null;

  const handleCreate = () => {
    if (!name.trim() || (type === 'ssh' && !host.trim())) return;

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
        config.password = password;
      }
    }

    onCreate(name.trim(), type, config, envVars);
    // Reset form
    setName(''); setHost(''); setPort('22'); setUsername('');
    setKeyPath(''); setPassword(''); setAuthMethod('agent'); setDefaultDir('~'); setEnvVars({});
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && name.trim() && (type !== 'ssh' || host.trim())) handleCreate();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="dialog-header">
          <span>New Environment</span>
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
            >
              <option value="ssh">SSH</option>
              <option value="local">Local</option>
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
                  <input
                    className="form-input"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter password"
                    style={{ marginTop: 6 }}
                  />
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
            </>
          )}

          <details className="form-group">
            <summary className="form-label" style={{ cursor: 'pointer' }}>
              Environment Variables (optional)
            </summary>
            <div style={{ marginTop: 8 }}>
              <EnvVarEditor vars={envVars} onChange={setEnvVars} compact />
            </div>
          </details>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
          <button
            className="form-btn form-btn--primary"
            onClick={handleCreate}
            disabled={!name.trim() || (type === 'ssh' && !host.trim())}
          >
            Create Environment
          </button>
        </div>
      </div>
    </div>
  );
}
