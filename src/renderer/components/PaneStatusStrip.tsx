import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentInfo } from '../../shared/types';
import { useSessionUsage } from '../hooks/useSessionUsage';
import { buildInspectorViewModel, type InspectableSession, type InspectorConfig } from '../utils/session-inspector';
import { SessionInspector } from './SessionInspector';

interface Props {
  sessionId: string | undefined;
  remoteStatus?: 'pending' | 'collecting' | 'unavailable';
  tetherSessionId?: string | null;
  session?: InspectableSession;
  environment?: EnvironmentInfo;
}

export function PaneStatusStrip({ sessionId, remoteStatus, tetherSessionId, session, environment }: Props) {
  const { usage, enabled } = useSessionUsage(sessionId);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [config, setConfig] = useState<InspectorConfig>({
    cliHooksEnabled: false,
    codexLifecycleHooksEnabled: false,
  });
  const configGenerationRef = useRef(0);

  const refreshConfig = useCallback(() => {
    const generation = ++configGenerationRef.current;
    void Promise.all([
      window.electronAPI.config.get('cliHooksEnabled').catch(() => null),
      window.electronAPI.config.get('codexLifecycleHooksEnabled').catch(() => null),
    ]).then(([cliHooksEnabled, codexLifecycleHooksEnabled]) => {
      if (generation !== configGenerationRef.current) return;
      setConfig({
        cliHooksEnabled: cliHooksEnabled === 'true',
        codexLifecycleHooksEnabled: codexLifecycleHooksEnabled === 'true',
      });
    });
  }, []);

  useEffect(() => {
    let active = true;
    const guardedRefreshConfig = () => {
      if (active) refreshConfig();
    };
    guardedRefreshConfig();
    const handleSettingsChanged = () => {
      guardedRefreshConfig();
    };
    window.addEventListener('tether:settings-changed', handleSettingsChanged);
    return () => {
      active = false;
      configGenerationRef.current++;
      window.removeEventListener('tether:settings-changed', handleSettingsChanged);
    };
  }, [refreshConfig]);

  if (!enabled) return null;
  if (!sessionId && !session) return null;

  const collectionStatus = remoteStatus ?? session?.remoteUsageStatus;
  const nativeSessionId = session?.toolSessionId || session?.claudeSessionId || (collectionStatus ? undefined : sessionId);
  const view = buildInspectorViewModel({
    nativeSessionId,
    tetherSessionId,
    session,
    environment,
    remoteStatus: collectionStatus,
    usage,
    config,
  });
  let collectionTitle: string | undefined;
  if (view.collectionUnavailable) {
    const collector = collectionStatus === 'unavailable' ? 'Remote collection' : 'Collection';
    const totals = view.usageAvailable ? ' Showing last collected totals.' : '';
    collectionTitle = `${collector} unavailable.${totals} Retrying automatically.`;
  }

  return (
    <div className="pane-status-strip" title={collectionTitle}>
      {!view.usageAvailable && (collectionStatus || view.collectionUnavailable) && <span className="pane-status-strip-item">{collectionStatus === 'pending' && !view.collectionUnavailable ? 'Waiting for remote usage' : 'Usage unavailable'}</span>}
      {view.usageAvailable && view.collectionUnavailable && <span className="pane-status-strip-item">Last collected</span>}
      {(view.usageAvailable || (!collectionStatus && !view.collectionUnavailable)) && <>
        <span className="pane-status-strip-item pane-status-strip-model">
        {view.stripModel ?? 'Unknown model'}
      </span>
      <span className="pane-status-strip-separator">·</span>
      <span className="pane-status-strip-item">
        {view.messageLabel}
      </span>
      <span className="pane-status-strip-separator">·</span>
      <span className="pane-status-strip-item pane-status-strip-cost">
        {view.costLabel} <span className="pane-status-strip-estimate">{view.costSourceLabel}</span>
      </span>
      </>}
      <span className="pane-status-strip-spacer" />
      <SessionInspector
        nativeSessionId={nativeSessionId}
        tetherSessionId={tetherSessionId}
        session={session}
        environment={environment}
        remoteStatus={collectionStatus}
        usage={usage}
        config={config}
        isOpen={inspectorOpen}
        onOpen={() => setInspectorOpen(true)}
        onClose={() => setInspectorOpen(false)}
      />
    </div>
  );
}
