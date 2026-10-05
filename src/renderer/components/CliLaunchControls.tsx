import { useEffect, useState } from 'react';
import { CLI_TOOL_REGISTRY, readCliLaunchOption, updateCliLaunchOption, type CliLaunchOption } from '../../shared/cli-tools';
import type { CliToolId } from '../../shared/types';

function LaunchOption({ option, flags, onFlagsChange }: Readonly<{
  option: CliLaunchOption;
  flags: string[];
  onFlagsChange: (flags: string[]) => void;
}>) {
  const selection = readCliLaunchOption(flags, option);
  const [draft, setDraft] = useState(selection);
  const [conflict, setConflict] = useState<string | null>(null);
  useEffect(() => { setDraft(selection); setConflict(null); }, [flags, selection]);
  const apply = () => {
    const result = updateCliLaunchOption(flags, option, draft);
    setConflict(result.conflict);
    if (!result.conflict) onFlagsChange(result.flags);
  };
  return (
    <div className="form-group">
      <label className="form-label">
        {option.label}
        <input className="form-input" value={draft} placeholder={option.placeholder} spellCheck={false}
          onChange={event => setDraft(event.target.value)} onBlur={apply}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }} />
      </label>
      <p className="form-hint">{option.hint}</p>
      {conflict && <p className="codex-settings-warning" role="alert">{conflict}</p>}
    </div>
  );
}

export function CliLaunchControls({ tool, title, flags, onFlagsChange }: Readonly<{
  tool: CliToolId;
  title: string;
  flags: string[];
  onFlagsChange: (flags: string[]) => void;
}>) {
  const definition = CLI_TOOL_REGISTRY[tool];
  if (!definition.launchOptions?.length) return null;
  return (
    <div className="codex-settings-launch">
      <h3>{title}</h3>
      <p className="form-hint">Applies to new {definition.displayName} sessions. Running sessions keep the settings they launched with.</p>
      <div className="codex-settings-grid">
        {definition.launchOptions.map(option => <LaunchOption key={`${tool}:${option.flag}`} option={option} flags={flags} onFlagsChange={onFlagsChange} />)}
      </div>
    </div>
  );
}
