import crypto from 'node:crypto';

export interface HostKeyFingerprints {
  /** OpenSSH-compatible SHA256 fingerprint body, without the `SHA256:` prefix. */
  sha256: string;
  /** Legacy Tether value: lowercase hex of the raw host key bytes. */
  legacyHex: string;
}

function keyToBuffer(key: string | Buffer): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key, 'binary');
}

export function hostKeyFingerprints(key: string | Buffer): HostKeyFingerprints {
  const raw = keyToBuffer(key);
  return {
    sha256: crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, ''),
    legacyHex: raw.toString('hex').toLowerCase(),
  };
}

export function formatSshFingerprint(fingerprint: string): string {
  return fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`;
}

