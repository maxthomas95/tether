import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './database';
import type { GitProviderRow } from './database';

export type { GitProviderRow };

export interface CreateGitProviderInput {
  name: string;
  type: 'gitea' | 'ado';
  baseUrl: string;
  organization?: string;
  token: string;
}

export function listGitProviders(): GitProviderRow[] {
  return getDb().gitProviders.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getGitProvider(id: string): GitProviderRow | undefined {
  return getDb().gitProviders.find(p => p.id === id);
}

export function createGitProvider(input: CreateGitProviderInput): GitProviderRow {
  const now = new Date().toISOString();
  const provider: GitProviderRow = {
    id: uuidv4(),
    name: input.name,
    type: input.type,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    organization: input.organization || null,
    token: input.token,
    created_at: now,
    updated_at: now,
  };
  getDb().gitProviders.push(provider);
  saveDb();
  return provider;
}

export function updateGitProvider(id: string, updates: Partial<CreateGitProviderInput>): void {
  const provider = getGitProvider(id);
  if (!provider) return;
  if (updates.name !== undefined) provider.name = updates.name;
  if (updates.type !== undefined) provider.type = updates.type;
  if (updates.baseUrl !== undefined) provider.baseUrl = updates.baseUrl.replace(/\/+$/, '');
  if (updates.organization !== undefined) provider.organization = updates.organization || null;
  if (updates.token !== undefined) provider.token = updates.token;
  provider.updated_at = new Date().toISOString();
  saveDb();
}

export function deleteGitProvider(id: string): void {
  const db = getDb();
  db.gitProviders = db.gitProviders.filter(p => p.id !== id);
  saveDb();
}
