import { describe, expect, it } from 'vitest';
import { formatSshFingerprint, hostKeyFingerprints } from './fingerprint';

describe('SSH fingerprint helpers', () => {
  it('builds OpenSSH SHA256 base64 and legacy hex fingerprints', () => {
    expect(hostKeyFingerprints(Buffer.from('hello'))).toEqual({
      sha256: 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
      legacySha256Hex: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
  });

  it('formats SHA256 fingerprints exactly once', () => {
    expect(formatSshFingerprint('abc')).toBe('SHA256:abc');
    expect(formatSshFingerprint('SHA256:abc')).toBe('SHA256:abc');
  });

  it('labels legacy SHA256 hex fingerprints honestly', () => {
    expect(formatSshFingerprint('2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824'))
      .toBe('legacy-sha256-hex:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

