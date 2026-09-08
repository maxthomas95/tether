import { useEffect, useMemo, useState } from 'react';
import { readCodexLaunchFlags, updateCodexLaunchFlags, type CodexReasoningEffort } from '../../shared/cli-tools';
import type { CliToolId, SessionInfo } from '../../shared/types';
import type { CodexConfigurationSnapshot } from '../../shared/codex-types';
import { CodexAccountPanel } from './CodexAccountPanel';
import '../styles/codex-settings.css';

type FlagsByTool = Partial<Record<CliToolId, string[]>>;

interface CodexSettingsSectionProps {
  cliFlagsPerTool: FlagsByTool;
  onCliFlagsPerToolChange: (flags: FlagsByTool) => void;
  profileCliFlagsPerTool: FlagsByTool;
  onProfileCliFlagsPerToolChange: (flags: FlagsByTool) => void;
  showProfileControls: boolean;
  cliHooksEnabled: boolean;
  codexLifecycleHooksEnabled: boolean;
  onCodexLifecycleHooksEnabledChange: (enabled: boolean) => void;
  quotaWarningPercent: number;
  onQuotaWarningPercentChange: (value: number) => void;
  sessions: SessionInfo[];
}

const FALLBACK_REASONING: CodexReasoningEffort[] = ['low', 'medium', 'high'];

function sanitizePercent(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function CodexLaunchControls({
  title,
  flags,
  onFlagsChange,
  configuration,
}: Readonly<{
  title: string;
  flags: string[];
  onFlagsChange: (flags: string[]) => void;
  configuration: CodexConfigurationSnapshot | null;
}>) {
  const selection = readCodexLaunchFlags(flags);
  const [manualModel, setManualModel] = useState(selection.model || '');
  const [manualProfile, setManualProfile] = useState(selection.profile || '');
  const [conflict, setConflict] = useState<string | null>(null);
  const models = useMemo(() => sortedUnique([
    ...(configuration?.models.map(model => model.id) ?? []),
    selection.model || '',
  ]), [configuration, selection.model]);
  const profiles = useMemo(() => sortedUnique([
    ...(configuration?.profiles.map(profile => profile.name) ?? []),
    selection.profile || '',
  ]), [configuration, selection.profile]);
  const activeModel = selection.model || '';
  const activeProfile = selection.profile || '';
  const modelMeta = configuration?.models.find(model => model.id === activeModel);
  const reasoningEfforts = sortedUnique([
    ...(modelMeta?.reasoningEfforts.length ? modelMeta.reasoningEfforts : FALLBACK_REASONING),
    selection.reasoningEffort || '',
  ]);

  useEffect(() => {
    setManualModel(selection.model || '');
    setManualProfile(selection.profile || '');
    setConflict(null);
  }, [flags, selection.model, selection.profile]);

  const apply = (next: { model?: string; profile?: string; reasoningEffort?: CodexReasoningEffort | '' }) => {
    const result = updateCodexLaunchFlags(flags, {
      model: next.model ?? selection.model ?? '',
      profile: next.profile ?? selection.profile ?? '',
      reasoningEffort: next.reasoningEffort ?? selection.reasoningEffort ?? '',
    });
    setConflict(result.conflict);
    if (!result.conflict) onFlagsChange(result.flags);
  };

  return (
    <div className="codex-settings-launch">
      <h3>{title}</h3>
      <p className="form-hint">Applies to new Codex sessions. Running sessions keep the settings they launched with.</p>
      <div className="codex-settings-grid">
        <label className="form-label">
          Model
          <select className="form-input" value={activeModel} onChange={e => {
            setManualModel(e.target.value);
            apply({ model: e.target.value });
          }}>
            <option value="">Codex default</option>
            {models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <label className="form-label">
          Manual model
          <input className="form-input" value={manualModel} onChange={e => setManualModel(e.target.value)} onBlur={() => apply({ model: manualModel.trim() })} placeholder="gpt-5.1-codex" spellCheck={false} />
        </label>
        <label className="form-label">
          Native profile
          <select className="form-input" value={activeProfile} onChange={e => {
            setManualProfile(e.target.value);
            apply({ profile: e.target.value });
          }}>
            <option value="">No profile flag</option>
            {profiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}
          </select>
        </label>
        <label className="form-label">
          Manual profile
          <input className="form-input" value={manualProfile} onChange={e => setManualProfile(e.target.value)} onBlur={() => apply({ profile: manualProfile.trim() })} placeholder="work" spellCheck={false} />
        </label>
        <label className="form-label">
          Reasoning
          <select className="form-input" value={selection.reasoningEffort || ''} onChange={e => apply({ reasoningEffort: e.target.value as CodexReasoningEffort | '' })}>
            <option value="">Codex default</option>
            {reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>
      </div>
      {conflict && <p className="codex-settings-warning" role="alert">{conflict}</p>}
    </div>
  );
}

export function CodexSettingsSection({
  cliFlagsPerTool,
  onCliFlagsPerToolChange,
  profileCliFlagsPerTool,
  onProfileCliFlagsPerToolChange,
  showProfileControls,
  cliHooksEnabled,
  codexLifecycleHooksEnabled,
  onCodexLifecycleHooksEnabledChange,
  quotaWarningPercent,
  onQuotaWarningPercentChange,
  sessions,
}: Readonly<CodexSettingsSectionProps>) {
  const [configuration, setConfiguration] = useState<CodexConfigurationSnapshot | null>(null);

  return (
    <>
      <div className="form-group">
        <CodexLaunchControls
          title="Default Codex launch"
          flags={cliFlagsPerTool.codex || []}
          onFlagsChange={flags => onCliFlagsPerToolChange({ ...cliFlagsPerTool, codex: flags })}
          configuration={configuration}
        />
      </div>
      {showProfileControls && (
        <div className="form-group">
          <CodexLaunchControls
            title="Current profile Codex launch"
            flags={profileCliFlagsPerTool.codex || []}
            onFlagsChange={flags => onProfileCliFlagsPerToolChange({ ...profileCliFlagsPerTool, codex: flags })}
            configuration={configuration}
          />
        </div>
      )}
      <div className="form-group">
        <label className="form-radio-label">
          <input
            type="checkbox"
            checked={codexLifecycleHooksEnabled}
            disabled={!cliHooksEnabled}
            onChange={e => onCodexLifecycleHooksEnabledChange(e.target.checked)}
          />
          <span>Track Codex lifecycle hooks</span>
          <span className="settings-tag settings-tag--experimental">Experimental</span>
        </label>
        <p className="form-hint">
          Requires the global CLI hooks setting. Takes effect after the next Tether launch and keeps your existing Codex hooks. Review native Codex hooks before trusting any command they run.
        </p>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="codex-quota-warning">
          Codex quota warning
          <input
            id="codex-quota-warning"
            className="form-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={quotaWarningPercent}
            onChange={e => onQuotaWarningPercentChange(sanitizePercent(e.target.value))}
          />
        </label>
        <p className="form-hint">Remaining percent threshold. Requires Usage subscription quota. 0 disables the warning.</p>
      </div>
      <CodexAccountPanel sessions={sessions} onConfigurationLoaded={setConfiguration} />
    </>
  );
}
