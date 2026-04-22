import React, { useEffect, useState } from 'react';
import type { VaultStatus } from '../../../shared/types';
import { onKeyActivate } from '../../utils/a11y';

type PillKind = 'ok' | 'warn' | 'expired';

const WARN_WINDOW_MS = 30 * 60 * 1000;

function computeKind(status: VaultStatus | null): PillKind {
  if (!status || !status.loggedIn) return 'expired';
  if (!status.expiresAt) return 'ok';
  const ms = Date.parse(status.expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  return ms <= WARN_WINDOW_MS ? 'warn' : 'ok';
}

function formatRemaining(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

function kindColor(kind: PillKind): string {
  switch (kind) {
    case 'ok': return 'var(--status-running)';
    case 'warn': return 'var(--status-waiting)';
    case 'expired': return 'var(--status-dead)';
  }
}

export function VaultStatusPill() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.vault.status().then(s => {
      if (!cancelled) setStatus(s);
    });
    const unsub = window.electronAPI.vault.onStatusChange(setStatus);
    return () => { cancelled = true; unsub(); };
  }, []);

  // Re-render each minute so the countdown stays fresh without a status event.
  useEffect(() => {
    const handle = setInterval(() => forceTick(t => t + 1), 60_000);
    return () => clearInterval(handle);
  }, []);

  // Only show the pill when Vault is configured for this user.
  if (!status?.enabled) return null;

  const kind = computeKind(status);
  const remaining = status.expiresAt ? formatRemaining(status.expiresAt) : '';
  const color = kindColor(kind);
  const dot = kind === 'expired' ? '○' : '●';
  const label = kind === 'expired'
    ? 'Log in to Vault'
    : `Vault${remaining ? ` · ${remaining}` : ''}`;
  const title = kind === 'expired'
    ? 'Click to log in to Vault'
    : `Click to renew Vault token${status.identity ? ` (signed in as ${status.identity})` : ''}`;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.electronAPI.vault.login();
    } catch {
      // login() rejects on user cancel or server error — let the status event
      // reflect the final state; no inline error UI in the pill.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="sidebar-footer vault-pill"
      role="button"
      tabIndex={0}
      title={title}
      onClick={handleClick}
      onKeyDown={onKeyActivate(handleClick)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: busy ? 'wait' : 'pointer' }}
    >
      <span style={{ color, fontSize: 10, lineHeight: 1 }}>{dot}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {busy ? 'Opening browser…' : label}
      </span>
    </div>
  );
}
