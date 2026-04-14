import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './database';
import type { KnownHostEntry } from './database';

export type { KnownHostEntry };

export interface SaveKnownHostInput {
  hostKey: string;
  keyHash: string;
  keyType?: string;
}

export function listKnownHosts(): KnownHostEntry[] {
  return getDb().knownHosts.slice().sort((a, b) => a.hostKey.localeCompare(b.hostKey));
}

export function findKnownHost(hostKey: string): KnownHostEntry | undefined {
  return getDb().knownHosts.find(h => h.hostKey === hostKey);
}

export function saveKnownHost(input: SaveKnownHostInput): KnownHostEntry {
  const existing = findKnownHost(input.hostKey);
  if (existing) {
    existing.keyHash = input.keyHash;
    existing.keyType = input.keyType || existing.keyType;
    existing.trustedAt = new Date().toISOString();
    saveDb();
    return existing;
  }
  const now = new Date().toISOString();
  const entry: KnownHostEntry = {
    id: uuidv4(),
    hostKey: input.hostKey,
    keyHash: input.keyHash,
    keyType: input.keyType || 'unknown',
    trustedAt: now,
    firstSeen: now,
  };
  getDb().knownHosts.push(entry);
  saveDb();
  return entry;
}

export function deleteKnownHost(id: string): void {
  const db = getDb();
  db.knownHosts = db.knownHosts.filter(h => h.id !== id);
  saveDb();
}
