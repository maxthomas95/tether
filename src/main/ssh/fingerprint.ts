import crypto from 'node:crypto';

export interface HostKeyFingerprints {
  /** OpenSSH-compatible SHA256 fingerprint body, without the `SHA256:` prefix. */
  sha256: string;
  /** Legacy Tether value: lowercase SHA256 hex digest produced by ssh2 hostHash. */
  legacySha256Hex: string;
}

const LEGACY_SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function keyToBuffer(key: string | Buffer): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key, 'binary');
}

function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  return value.slice(0, end);
}

export function hostKeyFingerprints(key: string | Buffer): HostKeyFingerprints {
  const raw = keyToBuffer(key);
  return {
    sha256: stripBase64Padding(crypto.createHash('sha256').update(raw).digest('base64')),
    legacySha256Hex: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

export function formatSshFingerprint(fingerprint: string): string {
  if (LEGACY_SHA256_HEX_RE.test(fingerprint)) return `legacy-sha256-hex:${fingerprint.toLowerCase()}`;
  return fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`;
}
