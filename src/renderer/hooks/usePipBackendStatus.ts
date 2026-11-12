import { useEffect, useState } from 'react';
import type { PipAiBackend, PipBackendStatus } from '../../shared/pip';

/**
 * Checks the chosen backend's sign-in and model when it is picked, or when Pip's options open with
 * AI quips on, so a missing sign-in shows up before the next session moment. Makes no model request.
 */
export function usePipBackendStatus(backend: PipAiBackend, enabled: boolean): { status: PipBackendStatus | null; checking: boolean } {
  const [status, setStatus] = useState<PipBackendStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setStatus(null);
    if (!enabled || !window.electronAPI?.pip?.backendStatus) { setChecking(false); return; }
    let cancelled = false;
    setChecking(true);
    window.electronAPI.pip.backendStatus(backend).then(value => {
      if (!cancelled) setStatus(value);
    }).catch(() => {
      if (!cancelled) setStatus({ backend, ready: false, detail: 'Could not check sign-in. Using local quips.' });
    }).finally(() => {
      if (!cancelled) setChecking(false);
    });
    return () => { cancelled = true; };
  }, [backend, enabled]);
  return { status: enabled ? status : null, checking: enabled && checking };
}
