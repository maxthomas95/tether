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
    connectConfig.agent = resolveAgentSocket();
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

/**
 * The agent ssh2 should talk to. `SSH_AUTH_SOCK` wins everywhere; Windows
 * falls back to the OpenSSH agent's named pipe. POSIX has no well-known
 * default socket, so fail with an actionable error instead of handing ssh2
 * a Windows pipe path.
 */
function resolveAgentSocket(): string {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  throw new Error(
    'SSH agent authentication is enabled, but SSH_AUTH_SOCK is not set. '
    + 'Start an SSH agent in the session that launches Tether, or use a private key file.',
  );
}
