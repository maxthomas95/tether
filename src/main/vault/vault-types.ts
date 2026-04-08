// Internal vault types — main process only.
// Public types (VaultConfig, VaultStatus, VaultPlaintextSecret, MigrateSecretOptions)
// live in src/shared/types.ts so the renderer can use them.

export interface ParsedVaultRef {
  /** KV mount, e.g. "secret" */
  mount: string;
  /** Logical secret path, e.g. "tether/ssh/prod-vm" */
  path: string;
  /** Field within the secret, e.g. "password" */
  key: string;
}

export interface KvReadResult {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface OidcAuthUrlResponse {
  auth_url: string;
}

export interface OidcCallbackResponse {
  client_token: string;
  ttl_seconds: number;
  identity?: string;
}

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}
