// Scrubbing helpers for diagnostics export. Strips secrets out of the
// app's data.json and log files before they go in the bundle, while
// keeping enough information that the export is still useful for
// debugging.
//
// Vault references (`vault://...`) are kept verbatim — they're pointers,
// not values, and useful for debugging session-launch issues.

import type { DbData } from '../db/database';
import { isVaultRef } from '../vault/vault-resolver';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /key|secret|token|password|credential|auth/i;
const ENCRYPTED_SECRET_PREFIX = 'tether-safe:v1:';
const CREDENTIAL_URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const BEARER_TOKEN_RE = /\b(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi;

// High-precision API-key prefixes (avoid false positives in log scrubbing).
const API_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,            // Anthropic
  /sk-[A-Za-z0-9]{32,}/g,                 // OpenAI-style
  /ghp_[A-Za-z0-9]{20,}/g,                // GitHub classic PAT
  /github_pat_[A-Za-z0-9_]{20,}/g,        // GitHub fine-grained PAT
  /glpat-[A-Za-z0-9_-]{20,}/g,            // GitLab PAT
  /xoxb-[A-Za-z0-9-]{20,}/g,              // Slack bot
  /AIza[A-Za-z0-9_-]{30,}/g,              // Google API
  /hvs\.[A-Za-z0-9_-]{20,}/g,             // HashiCorp Vault token
];

/**
 * Returns `true` if a key looks sensitive (likely contains a secret).
 * Used to decide whether to redact the *value* of a key=value pair.
 */
function looksSensitive(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function looksSensitiveValue(value: string): boolean {
  if (value.startsWith(ENCRYPTED_SECRET_PREFIX)) return true;
  if (CREDENTIAL_URL_RE.test(value)) {
    CREDENTIAL_URL_RE.lastIndex = 0;
    return true;
  }
  CREDENTIAL_URL_RE.lastIndex = 0;
  return API_KEY_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function scrubEnvVarsJson(rawJson: string | undefined): string {
  if (!rawJson) return rawJson ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rawJson; // leave malformed JSON alone — caller's problem
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      scrubbed[k] = v;
      continue;
    }
    if (isVaultRef(v)) {
      scrubbed[k] = v;            // refs are not secrets
    } else if (looksSensitive(k) || looksSensitiveValue(v)) {
      scrubbed[k] = REDACTED;
    } else {
      scrubbed[k] = v;
    }
  }
  return JSON.stringify(scrubbed);
}

function scrubEnvConfigJson(rawJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  const out = { ...parsed };
  if (typeof out.password === 'string' && !isVaultRef(out.password)) {
    out.password = REDACTED;
    delete out.passwordEncrypted; // metadata about the now-redacted password
  }
  return JSON.stringify(out);
}

/**
 * Returns a deep-cloned, scrubbed copy of `DbData`. The original is not
 * mutated.
 */
export function scrubDbData(input: DbData): DbData {
  // Deep clone via JSON round-trip — DbData is plain JSON.
  const db: DbData = JSON.parse(JSON.stringify(input));

  for (const env of db.environments) {
    env.config = scrubEnvConfigJson(env.config);
    env.env_vars = scrubEnvVarsJson(env.env_vars);
  }

  for (const profile of db.launchProfiles) {
    profile.env_vars = scrubEnvVarsJson(profile.env_vars);
  }

  for (const provider of db.gitProviders) {
    if (provider.token && !isVaultRef(provider.token)) {
      provider.token = REDACTED;
    }
  }

  // Vault token (encrypted in storage but redact regardless — diagnostics
  // shouldn't carry any auth material, encrypted or not).
  if (db.config.vaultToken) {
    db.config.vaultToken = REDACTED;
  }

  // Default env vars.
  for (const k of Object.keys(db.defaultEnvVars)) {
    const v = db.defaultEnvVars[k];
    if (typeof v === 'string' && !isVaultRef(v) && (looksSensitive(k) || looksSensitiveValue(v))) {
      db.defaultEnvVars[k] = REDACTED;
    }
  }

  return db;
}

/**
 * Best-effort scrubbing of a single log line: replaces well-known API key
 * prefixes with [REDACTED-API-KEY]. Misses by design — high precision over
 * recall — so the user can still read their logs for debugging context.
 */
export function scrubLogLine(line: string): string {
  let out = line;
  for (const pattern of API_KEY_PATTERNS) {
    out = out.replace(pattern, '[REDACTED-API-KEY]');
  }
  out = out.replace(CREDENTIAL_URL_RE, '$1[REDACTED]@');
  out = out.replace(BEARER_TOKEN_RE, '$1[REDACTED-API-KEY]');
  return out;
}

export function scrubLogText(text: string): string {
  return text.split('\n').map(scrubLogLine).join('\n');
}
