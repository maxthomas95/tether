import fs from 'node:fs';
import { verifyHost } from '../ssh/host-verifier';
import { hostKeyFingerprints } from '../ssh/fingerprint';
import type { SSHConfig } from './ssh-transport';

/**
 * Build the ssh2 `connect()` config for an `SSHConfig`: keepalive, timeouts,
 * host-key verification (TOFU/known-hosts via `verifyHost`), and the
 * agent/key/password auth cascade. Shared by the PTY transport and the remote
 * hook agent's control connection so a host the user trusted once is trusted
 * identically on both paths, and auth never diverges between them.
 *
 * @param onVerifyError Receives a human-friendly reason when host verification
 *   rejects the connection; callers surface it instead of the generic ssh2
 *   error. May be called before the ssh2 'error' event fires.
 */
export function buildSshConnectConfig(
  sshConfig: SSHConfig,
  onVerifyError: (reason: string) => void,
): Record<string, unknown> {
  const connectConfig: Record<string, unknown> = {
    host: sshConfig.host,
    port: sshConfig.port || 22,
    username: sshConfig.username,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    readyTimeout: 15000,
    hostVerifier: (key: string | Buffer, callback: (accept: boolean) => void) => {
      const fingerprints = hostKeyFingerprints(key);
      verifyHost(
        sshConfig.host,
        sshConfig.port || 22,
        fingerprints.sha256,
        sshConfig.username,
        fingerprints.legacySha256Hex,
      )
        .then((result) => {
          if (!result.trust && result.reason) {
            onVerifyError(result.reason);
          }
          callback(result.trust);
        })
        .catch((err: Error) => {
          onVerifyError(err.message || 'Host key verification failed');
          callback(false);
        });
    },
  };

  if (sshConfig.useAgent) {
    // Windows OpenSSH agent
    connectConfig.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  } else if (sshConfig.privateKeyPath) {
    try {
      connectConfig.privateKey = fs.readFileSync(sshConfig.privateKeyPath);
    } catch {
      throw new Error(`Failed to read SSH key: ${sshConfig.privateKeyPath}`);
    }
  } else if (sshConfig.password) {
    connectConfig.password = sshConfig.password;
  }

  return connectConfig;
}
