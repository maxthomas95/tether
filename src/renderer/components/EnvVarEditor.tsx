import { useState, useCallback } from 'react';

const CLAUDE_PRESETS = [
  { key: 'ANTHROPIC_API_KEY', label: 'API Key' },
  { key: 'ANTHROPIC_MODEL', label: 'Model' },
  { key: 'ANTHROPIC_SMALL_FAST_MODEL', label: 'Small/Fast Model' },
  { key: 'ANTHROPIC_BASE_URL', label: 'Base URL (OpenRouter)' },
  { key: 'CLAUDE_CODE_MAX_TURNS', label: 'Max Turns' },
  { key: 'CLAUDE_CODE_USE_BEDROCK', label: 'Use Bedrock' },
  { key: 'CLAUDE_CODE_USE_VERTEX', label: 'Use Vertex' },
  { key: 'AWS_PROFILE', label: 'AWS Profile' },
  { key: 'AWS_REGION', label: 'AWS Region' },
];

const SENSITIVE_PATTERNS = /key|secret|token|password/i;

interface EnvVarEditorProps {
  vars: Record<string, string>;
  onChange: (vars: Record<string, string>) => void;
  inheritedVars?: Record<string, string>;
  compact?: boolean;
}

interface VarRow {
  id: number;
  key: string;
  value: string;
}

let nextId = 1;

function toRows(vars: Record<string, string>): VarRow[] {
  return Object.entries(vars).map(([key, value]) => ({ id: nextId++, key, value }));
}

function toRecord(rows: VarRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) result[row.key.trim()] = row.value;
  }
  return result;
}

export function EnvVarEditor({ vars, onChange, inheritedVars, compact }: EnvVarEditorProps) {
  const [rows, setRows] = useState<VarRow[]>(() => toRows(vars));
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [showPresets, setShowPresets] = useState(false);

  const update = useCallback((newRows: VarRow[]) => {
    setRows(newRows);
    onChange(toRecord(newRows));
  }, [onChange]);

  const addRow = useCallback((key = '', value = '') => {
    const newRows = [...rows, { id: nextId++, key, value }];
    update(newRows);
  }, [rows, update]);

  const removeRow = useCallback((id: number) => {
    update(rows.filter(r => r.id !== id));
  }, [rows, update]);

  const updateRow = useCallback((id: number, field: 'key' | 'value', val: string) => {
    update(rows.map(r => r.id === id ? { ...r, [field]: val } : r));
  }, [rows, update]);

  const toggleReveal = useCallback((id: number) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const addPreset = useCallback((key: string) => {
    if (!rows.some(r => r.key === key)) {
      addRow(key, '');
    }
    setShowPresets(false);
  }, [rows, addRow]);

  const overrideInherited = useCallback((key: string, value: string) => {
    addRow(key, value);
  }, [addRow]);

  const isSensitive = (key: string) => SENSITIVE_PATTERNS.test(key);
  const existingKeys = new Set(rows.map(r => r.key));

  return (
    <div className={`env-editor ${compact ? 'env-editor--compact' : ''}`}>
      {/* Inherited vars */}
      {inheritedVars && Object.keys(inheritedVars).length > 0 && (
        <div className="env-editor-inherited-section">
          {Object.entries(inheritedVars)
            .filter(([k]) => !existingKeys.has(k))
            .map(([key, value]) => (
              <div key={key} className="env-editor-row env-editor-row--inherited">
                <input className="form-input env-editor-key" value={key} disabled />
                <input
                  className="form-input env-editor-value"
                  value={isSensitive(key) ? '\u2022\u2022\u2022\u2022\u2022\u2022' : value}
                  disabled
                />
                <button
                  className="env-editor-btn"
                  title="Override this value"
                  onClick={() => overrideInherited(key, value)}
                >
                  Override
                </button>
              </div>
            ))}
        </div>
      )}

      {/* Editable rows */}
      {rows.map(row => (
        <div key={row.id} className="env-editor-row">
          <input
            className="form-input env-editor-key"
            value={row.key}
            onChange={e => updateRow(row.id, 'key', e.target.value)}
            placeholder="VAR_NAME"
          />
          <div className="env-editor-value-wrap">
            <input
              className="form-input env-editor-value"
              type={isSensitive(row.key) && !revealed.has(row.id) ? 'password' : 'text'}
              value={row.value}
              onChange={e => updateRow(row.id, 'value', e.target.value)}
              placeholder="value"
            />
            {isSensitive(row.key) && (
              <button
                className="env-editor-reveal"
                onClick={() => toggleReveal(row.id)}
                title={revealed.has(row.id) ? 'Hide' : 'Show'}
              >
                {revealed.has(row.id) ? '\u25C9' : '\u25CE'}
              </button>
            )}
          </div>
          <button
            className="env-editor-btn env-editor-btn--remove"
            onClick={() => removeRow(row.id)}
            title="Remove"
          >
            &times;
          </button>
        </div>
      ))}

      {/* Actions */}
      <div className="env-editor-actions">
        <button className="env-editor-btn" onClick={() => addRow()}>
          + Add Variable
        </button>
        <div className="env-editor-preset-wrap">
          <button
            className="env-editor-btn"
            onClick={() => setShowPresets(!showPresets)}
          >
            Quick Add &darr;
          </button>
          {showPresets && (
            <div className="env-editor-presets">
              {CLAUDE_PRESETS.filter(p => !existingKeys.has(p.key)).map(preset => (
                <div
                  key={preset.key}
                  className="env-editor-preset-item"
                  onClick={() => addPreset(preset.key)}
                >
                  <span className="env-editor-preset-key">{preset.key}</span>
                  <span className="env-editor-preset-label">{preset.label}</span>
                </div>
              ))}
              {CLAUDE_PRESETS.every(p => existingKeys.has(p.key)) && (
                <div className="env-editor-preset-item" style={{ opacity: 0.5 }}>
                  All presets added
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
