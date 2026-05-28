import { describe, it, expect } from 'vitest';
import { scrubDbData, scrubLogLine, scrubLogText } from './scrub';
import type { DbData, EnvironmentRow, GitProviderRow, LaunchProfileRow } from '../db/database';

function emptyDb(overrides: Partial<DbData> = {}): DbData {
  return {
    environments: [],
    sessions: [],
    launchProfiles: [],
    config: {},
    defaultEnvVars: {},
    defaultCliFlags: [],
    defaultCliFlagsPerTool: {},
    savedWorkspace: null,
    gitProviders: [],
    repoGroupPrefs: [],
    sessionOrderPrefs: [],
    usageSummaries: [],
    knownHosts: [],
    ...overrides,
  };
}

function makeEnv(overrides: Partial<EnvironmentRow> = {}): EnvironmentRow {
  return {
    id: 'env-1',
    name: 'Local',
    type: 'local',
    config: '{}',
    env_vars: '{}',
    auth_mode: null,
    model: null,
    small_model: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<LaunchProfileRow> = {}): LaunchProfileRow {
  return {
    id: 'p-1',
    name: 'Default',
    env_vars: '{}',
    cli_flags: '[]',
    cli_flags_per_tool: '{}',
    is_default: true,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeGitProvider(overrides: Partial<GitProviderRow> = {}): GitProviderRow {
  return {
    id: 'gp-1',
    name: 'GitHub',
    type: 'github',
    baseUrl: 'https://api.github.com',
    organization: null,
    token: 'ghp_realtoken1234567890ABCD',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('scrubDbData', () => {
  it('returns a clone — does not mutate input', () => {
    const original = emptyDb({
      environments: [makeEnv({ config: JSON.stringify({ password: 'secret' }) })],
    });
    const before = JSON.stringify(original);
    scrubDbData(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('redacts plaintext SSH password and strips passwordEncrypted metadata', () => {
    const db = emptyDb({
      environments: [makeEnv({
        type: 'ssh',
        config: JSON.stringify({
          host: 'box.example',
          port: 22,
          username: 'me',
          password: 'base64encodedstuff',
          passwordEncrypted: true,
        }),
      })],
    });
    const out = scrubDbData(db);
    const cfg = JSON.parse(out.environments[0].config);
    expect(cfg.password).toBe('[REDACTED]');
    expect(cfg.passwordEncrypted).toBeUndefined();
    expect(cfg.host).toBe('box.example'); // host info preserved
    expect(cfg.username).toBe('me');
  });

  it('keeps a vault:// password ref intact', () => {
    const db = emptyDb({
      environments: [makeEnv({
        type: 'ssh',
        config: JSON.stringify({ password: 'vault://secret/ssh/box#password' }),
      })],
    });
    const cfg = JSON.parse(scrubDbData(db).environments[0].config);
    expect(cfg.password).toBe('vault://secret/ssh/box#password');
  });

  it('redacts sensitive env-var values, keeps non-sensitive ones, keeps vault refs', () => {
    const db = emptyDb({
      environments: [makeEnv({
        env_vars: JSON.stringify({
          ANTHROPIC_API_KEY: 'sk-ant-real',
          NODE_ENV: 'development',
          CUSTOM_TOKEN: 'plaintext',
          OTHER_SECRET: 'vault://secret/foo#k',
        }),
      })],
    });
    const env = JSON.parse(scrubDbData(db).environments[0].env_vars);
    expect(env.ANTHROPIC_API_KEY).toBe('[REDACTED]');
    expect(env.CUSTOM_TOKEN).toBe('[REDACTED]');
    expect(env.NODE_ENV).toBe('development');
    expect(env.OTHER_SECRET).toBe('vault://secret/foo#k');
  });

  it('redacts API-key-looking env values even under benign names', () => {
    const db = emptyDb({
      environments: [makeEnv({
        env_vars: JSON.stringify({
          DATABASE_URL: 'postgres://user:pass@example.com/db',
          SERVICE_VALUE: 'ghp_abcdef1234567890ABCDEF',
          NORMAL: 'value',
        }),
      })],
    });
    const env = JSON.parse(scrubDbData(db).environments[0].env_vars);
    expect(env.DATABASE_URL).toBe('[REDACTED]');
    expect(env.SERVICE_VALUE).toBe('[REDACTED]');
    expect(env.NORMAL).toBe('value');
  });

  it('applies the same env-var rules to launchProfiles', () => {
    const db = emptyDb({
      launchProfiles: [makeProfile({
        env_vars: JSON.stringify({ MY_SECRET: 'plaintext', LOG_LEVEL: 'debug' }),
      })],
    });
    const env = JSON.parse(scrubDbData(db).launchProfiles[0].env_vars);
    expect(env.MY_SECRET).toBe('[REDACTED]');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('redacts plaintext git provider tokens, keeps vault refs', () => {
    const db = emptyDb({
      gitProviders: [
        makeGitProvider({ id: 'gp-1', token: 'ghp_realtoken1234567890ABCD' }),
        makeGitProvider({ id: 'gp-2', token: 'vault://secret/git/github#token' }),
      ],
    });
    const out = scrubDbData(db);
    expect(out.gitProviders[0].token).toBe('[REDACTED]');
    expect(out.gitProviders[1].token).toBe('vault://secret/git/github#token');
  });

  it('redacts the vaultToken in config', () => {
    const db = emptyDb({
      config: { vaultToken: 'hvs.realtoken', vaultIdentity: 'alice@example.com' },
    });
    const out = scrubDbData(db);
    expect(out.config.vaultToken).toBe('[REDACTED]');
    expect(out.config.vaultIdentity).toBe('alice@example.com'); // identity stays
  });

  it('redacts sensitive defaultEnvVars values only', () => {
    const db = emptyDb({
      defaultEnvVars: {
        OPENAI_API_KEY: 'sk-real',
        NORMAL_VAR: 'value',
        VAULTED_KEY: 'vault://secret/keys#anth',
      },
    });
    const out = scrubDbData(db).defaultEnvVars;
    expect(out.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(out.NORMAL_VAR).toBe('value');
    expect(out.VAULTED_KEY).toBe('vault://secret/keys#anth');
  });

  it('preserves usage summaries and known hosts (not secrets)', () => {
    const db = emptyDb({
      usageSummaries: [{
        sessionId: 'abc', cliTool: 'claude', workingDir: '/repo', inputTokens: 100,
        outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.01,
        models: [], messageCount: 1, firstMessageAt: null, lastMessageAt: null, parsedByteOffset: 0,
      }],
      knownHosts: [{ id: 'h1', hostKey: 'host:22', keyHash: 'sha256:abc', keyType: 'rsa', trustedAt: 't', firstSeen: 't' }],
    });
    const out = scrubDbData(db);
    expect(out.usageSummaries).toHaveLength(1);
    expect(out.knownHosts[0].keyHash).toBe('sha256:abc');
  });

  it('leaves malformed env_vars JSON alone rather than crashing', () => {
    const db = emptyDb({
      environments: [makeEnv({ env_vars: '{not valid' })],
    });
    expect(() => scrubDbData(db)).not.toThrow();
    expect(scrubDbData(db).environments[0].env_vars).toBe('{not valid');
  });
});

describe('scrubLogLine', () => {
  it('redacts an Anthropic API key', () => {
    expect(scrubLogLine('using key sk-ant-abcdef1234567890XYZ')).toBe('using key [REDACTED-API-KEY]');
  });

  it('redacts a GitHub classic PAT', () => {
    expect(scrubLogLine('token=ghp_abcdef1234567890ABCDEF in request')).toBe('token=[REDACTED-API-KEY] in request');
  });

  it('redacts a GitHub fine-grained PAT', () => {
    expect(scrubLogLine('Authorization: github_pat_1234567890ABCDEFGHIJKLMNOP')).toBe('Authorization: [REDACTED-API-KEY]');
  });

  it('redacts a Vault HCP token', () => {
    expect(scrubLogLine('vault token hvs.CAESIQabcdef1234567890XYZ used')).toBe('vault token [REDACTED-API-KEY] used');
  });

  it('does not redact unrelated tokens or short strings', () => {
    expect(scrubLogLine('the spk-an quick brown fox')).toBe('the spk-an quick brown fox');
    expect(scrubLogLine('short ghp_abc')).toBe('short ghp_abc');
  });

  it('redacts multiple keys in one line', () => {
    const out = scrubLogLine('keys sk-ant-abcdef1234567890 and ghp_abcdef1234567890ABCD');
    expect(out).toBe('keys [REDACTED-API-KEY] and [REDACTED-API-KEY]');
  });

  it('redacts credential URLs and bearer tokens in logs', () => {
    expect(scrubLogLine('url https://user:pass@example.com/repo.git'))
      .toBe('url https://[REDACTED]@example.com/repo.git');
    expect(scrubLogLine('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'))
      .toBe('Authorization: Bearer [REDACTED-API-KEY]');
  });
});

describe('scrubLogText', () => {
  it('processes each line independently', () => {
    const text = [
      'no secrets here',
      'using sk-ant-realsecret1234567890ABC',
      'plain line',
    ].join('\n');
    const out = scrubLogText(text);
    expect(out).toBe([
      'no secrets here',
      'using [REDACTED-API-KEY]',
      'plain line',
    ].join('\n'));
  });
});
