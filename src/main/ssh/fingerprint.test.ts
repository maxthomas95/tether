import { describe, expect, it } from 'vitest';
import { formatSshFingerprint, hostKeyFingerprints } from './fingerprint';

describe('SSH fingerprint helpers', () => {
  it('builds OpenSSH SHA256 base64 and legacy hex fingerprints', () => {
    expect(hostKeyFingerprints(Buffer.from('hello'))).toEqual({
      sha256: 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
      legacyHex: '68656c6c6f',
    });
  });

  it('formats SHA256 fingerprints exactly once', () => {
    expect(formatSshFingerprint('abc')).toBe('SHA256:abc');
    expect(formatSshFingerprint('SHA256:abc')).toBe('SHA256:abc');
  });
});

