import type { DbData } from '../database';

let data: DbData = createFreshDb();

function createFreshDb(): DbData {
  return {
    environments: [],
    sessions: [],
    launchProfiles: [],
    config: {},
    defaultEnvVars: {},
    defaultCliFlags: [],
    savedWorkspace: null,
    gitProviders: [],
  };
}

export function getDb(): DbData {
  return data;
}

export function saveDb(): void {
  // no-op in tests — data is in memory
}

export function closeDb(): void {
  data = createFreshDb();
}

/** Test helper: reset to empty state between tests. */
export function __resetDb(): void {
  data = createFreshDb();
}
