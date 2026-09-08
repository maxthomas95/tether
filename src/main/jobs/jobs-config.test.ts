import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOBS_SETTINGS } from '../../shared/jobs';

const db = vi.hoisted(() => ({ config: {} as Record<string, string> }));
const save = vi.hoisted(() => vi.fn());
const encrypt = vi.hoisted(() => vi.fn((value: string) => value ? `encrypted:${value}` : ''));
vi.mock('../db/database', () => ({ getDb: () => db, saveDb: save }));
vi.mock('../db/secret-storage', () => ({
  encryptSecretForStorage: encrypt,
  decryptSecretFromStorage: (value: string) => value.replace('encrypted:', ''),
}));
import { disableJobsConfig, readJobsConfig, saveJobsConfig } from './jobs-config';

beforeEach(() => { db.config = {}; vi.clearAllMocks(); });

describe('JOBS preferences', () => {
  it('requires opt-in for fresh installs and preserves explicit legacy setups', () => {
    expect(readJobsConfig()).toEqual(DEFAULT_JOBS_SETTINGS);
    db.config = { jobsEnabled: 'auto', jobsPath: '/office', jobsToken: 'encrypted:secret' };
    expect(readJobsConfig()).toMatchObject({ enabled: 'auto', autoLaunch: true, shareRemoteSessions: true, token: 'secret' });
    db.config.jobsShareRemoteSessions = 'false';
    db.config.jobsAutoLaunch = 'false';
    expect(readJobsConfig()).toMatchObject({ shareRemoteSessions: false, autoLaunch: false });
  });

  it('stores a complete normalized setup with an encrypted token in one write', () => {
    db.config = { theme: 'mocha' };
    saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', url: ' https://office.example/base/// ', token: ' secret ' });
    expect(db.config).toMatchObject({ jobsUrl: 'https://office.example/base', jobsToken: 'encrypted:secret', jobsShareRemoteSessions: 'false', theme: 'mocha' });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(['file:///office', 'https://user:secret@office.example', 'http://localhost:8780/?token=secret', 'not a URL', 'https://office/#view'])('rejects invalid server URLs without partial saves: %s', url => {
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, url })).toThrow();
    expect(db.config).toEqual({});
    expect(save).not.toHaveBeenCalled();
  });

  it('validates local launch separately from a remote or view-only connection', () => {
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', autoLaunch: true })).toThrow('Choose a built');
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', autoLaunch: true, path: '/office', url: 'https://office.example' })).toThrow('local HTTP');
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', url: 'https://office.example' })).not.toThrow();
  });

  it('does not change settings if encryption or persistence fails', () => {
    db.config = { jobsEnabled: 'off', theme: 'mocha' };
    encrypt.mockImplementationOnce(() => { throw new Error('Keychain unavailable'); });
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', token: 'secret' })).toThrow('Keychain');
    expect(db.config).toEqual({ jobsEnabled: 'off', theme: 'mocha' });
    save.mockImplementationOnce(() => { throw new Error('Disk full'); });
    expect(() => saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto' })).toThrow('Disk full');
    expect(db.config).toEqual({ jobsEnabled: 'off', theme: 'mocha' });
  });

  it('pauses without forgetting, removes only JOBS settings, and stays opted out', () => {
    saveJobsConfig({ ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', token: 'secret', path: '/office' });
    db.config.theme = 'mocha';
    disableJobsConfig();
    expect(readJobsConfig()).toMatchObject({ enabled: 'off', token: 'secret', path: '/office' });
    disableJobsConfig(true);
    expect(db.config).toEqual({ jobsEnabled: 'off', theme: 'mocha' });
    expect(readJobsConfig()).toEqual(DEFAULT_JOBS_SETTINGS);
  });

  it('preserves the sharing preference when pausing a legacy setup', () => {
    db.config = { jobsEnabled: 'auto' };
    disableJobsConfig();
    expect(readJobsConfig()).toMatchObject({ enabled: 'off', shareRemoteSessions: true });
  });
});
