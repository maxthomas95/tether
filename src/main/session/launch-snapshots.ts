import { v4 as uuidv4 } from 'uuid';
import type { CreateSessionOptions } from '../../shared/types';
import type { LaunchSnapshotRow } from '../db/database';
import { getDb, saveDb } from '../db/database';
import { decryptSecretFromStorage, encryptSecretForStorage, isEncryptedSecret } from '../db/secret-storage';
import { getProfile } from '../db/profile-repo';

export interface LaunchIntent {
  version: 1;
  profileId?: string;
  env?: Record<string, string>;
  cliArgs?: string[];
  disabledInheritedFlags?: string[];
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Saved launch settings are invalid');
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error('Saved launch settings are invalid');
    out[key] = item;
  }
  return out;
}

function cloneStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Saved launch settings are invalid');
  }
  return [...value];
}

export function captureLaunchIntent(opts: CreateSessionOptions): LaunchIntent | null {
  const intent: LaunchIntent = {
    version: 1,
    profileId: typeof opts.profileId === 'string' && opts.profileId ? opts.profileId : undefined,
  };
  if (hasOwn(opts, 'env') && opts.env !== undefined) intent.env = cloneRecord(opts.env);
  if (hasOwn(opts, 'cliArgs') && opts.cliArgs !== undefined) intent.cliArgs = cloneStringArray(opts.cliArgs);
  if (hasOwn(opts, 'disabledInheritedFlags') && opts.disabledInheritedFlags !== undefined) intent.disabledInheritedFlags = cloneStringArray(opts.disabledInheritedFlags);
  return intent.profileId || intent.env || intent.cliArgs || intent.disabledInheritedFlags ? intent : null;
}

function validateLaunchIntent(value: unknown): LaunchIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Saved launch settings are invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error('Saved launch settings use an unsupported version');
  }
  const intent: LaunchIntent = { version: 1 };
  if (record.profileId !== undefined) {
    if (typeof record.profileId !== 'string' || !record.profileId) throw new Error('Saved launch settings are invalid');
    intent.profileId = record.profileId;
  }
  if (record.env !== undefined) {
    intent.env = cloneRecord(record.env);
  }
  if (record.cliArgs !== undefined) {
    intent.cliArgs = cloneStringArray(record.cliArgs);
  }
  if (record.disabledInheritedFlags !== undefined) {
    intent.disabledInheritedFlags = cloneStringArray(record.disabledInheritedFlags);
  }
  return intent;
}

export function readLaunchIntent(snapshotId: string): LaunchIntent {
  const row = getDb().launchSnapshots[snapshotId];
  if (!row) throw new Error('Saved launch settings were not found');
  if (row.version !== 1 || typeof row.encryptedIntent !== 'string' || !isEncryptedSecret(row.encryptedIntent)) {
    throw new Error('Saved launch settings are invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecretFromStorage(row.encryptedIntent, 'launch settings'));
  } catch {
    throw new Error('Saved launch settings could not be decrypted');
  }
  const intent = validateLaunchIntent(parsed);
  if (intent.profileId && !getProfile(intent.profileId)) {
    throw new Error('Saved launch profile no longer exists');
  }
  return intent;
}

export function applyLaunchIntent(opts: CreateSessionOptions, intent: LaunchIntent): CreateSessionOptions {
  return {
    ...opts,
    profileId: intent.profileId,
    env: intent.env ? { ...intent.env } : undefined,
    cliArgs: intent.cliArgs ? [...intent.cliArgs] : undefined,
    disabledInheritedFlags: intent.disabledInheritedFlags ? [...intent.disabledInheritedFlags] : undefined,
    cloneUrl: undefined,
    initialPrompt: undefined,
  };
}

export function createLaunchSnapshot(intent: LaunchIntent | null): string | undefined {
  const prepared = prepareLaunchSnapshot(intent);
  if (!prepared) return undefined;
  persistLaunchSnapshot(prepared);
  return prepared.id;
}

export function prepareLaunchSnapshot(intent: LaunchIntent | null): LaunchSnapshotRow | null {
  if (!intent) return null;
  const now = new Date().toISOString();
  const id = uuidv4();
  return {
    id,
    version: 1,
    encryptedIntent: encryptSecretForStorage(JSON.stringify(intent), 'launch settings'),
    createdAt: now,
    updatedAt: now,
  };
}

export function persistLaunchSnapshot(row: LaunchSnapshotRow): void {
  getDb().launchSnapshots[row.id] = row;
  saveDb();
}
