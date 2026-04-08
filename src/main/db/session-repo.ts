import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './database';
import type { SessionRow } from './database';

export type { SessionRow };

export interface CreateSessionInput {
  environment_id?: string;
  label: string;
  working_dir: string;
  state?: string;
}

export function listSessions(): SessionRow[] {
  return getDb().sessions.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

export function getSessionRow(id: string): SessionRow | undefined {
  return getDb().sessions.find(s => s.id === id);
}

export function createSessionRow(input: CreateSessionInput): SessionRow {
  const now = new Date().toISOString();
  const session: SessionRow = {
    id: uuidv4(),
    environment_id: input.environment_id || null,
    label: input.label,
    working_dir: input.working_dir,
    state: input.state || 'starting',
    auth_mode: null,
    model: null,
    small_model: null,
    pid: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
    last_active_at: now,
  };
  getDb().sessions.push(session);
  saveDb();
  return session;
}

export function updateSessionState(id: string, state: string): void {
  const session = getSessionRow(id);
  if (!session) return;
  const now = new Date().toISOString();
  session.state = state;
  session.updated_at = now;
  session.last_active_at = now;
  saveDb();
}

export function updateSessionLabel(id: string, label: string): void {
  const session = getSessionRow(id);
  if (!session) return;
  session.label = label;
  session.updated_at = new Date().toISOString();
  saveDb();
}

export function deleteSessionRow(id: string): void {
  const db = getDb();
  db.sessions = db.sessions.filter(s => s.id !== id);
  saveDb();
}

export function markAllRunningAsStopped(): void {
  const activeStates = ['starting', 'running', 'waiting', 'idle'];
  for (const session of getDb().sessions) {
    if (activeStates.includes(session.state)) {
      session.state = 'stopped';
      session.pid = null;
    }
  }
  saveDb();
}
