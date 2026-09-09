# Vault

Tether integrates with [HashiCorp Vault](https://www.vaultproject.io/) so you don't have to store API keys or other secrets in plaintext. Env-var values can be `vault://` references that resolve to the actual secret at session start.

## Setup

Configure Vault in [Settings → Integrations → Vault](settings.md#integrations).

You need:

- **Vault address** — e.g. `https://vault.example.com:8200`
- **Namespace** *(optional)* — for Vault Enterprise multi-tenancy
- **KV mount** — defaults to `secret` (the KV v2 mount path)
- **OIDC role** — the role configured for browser login on your Vault server

Enable the integration, fill in those fields, and click **Log In**. The login action saves the Vault configuration before opening your browser. There is no token-paste or token-file login control.

### Browser login

Tether opens your browser for OIDC authentication and completes login through a local callback at `http://localhost:8250/oidc/callback`. Your Vault OIDC role must allow that redirect URI. The resulting token is cached encrypted in `data.json` using the OS keychain; Tether refuses to cache it if encryption is unavailable. Your Vault policy must permit reading the paths you reference, listing paths for the picker, and writing paths for migration.

Tether warns 30 minutes before a known token expiry. Click the sidebar Vault pill to log in again; tokens are not automatically renewed. **Log Out** clears the cached token.

If you close the browser before finishing login, click **Cancel Vault login** in the sidebar or **Cancel login** in Settings or setup, then log in again. In the session login prompt, use **Cancel** or close the prompt. Tether cannot detect when an external browser tab closes; an abandoned login otherwise times out after five minutes.

If another application is using callback port 8250, login fails immediately without leaving a pending login timer. Free the port and try logging in again.

A status pill in the sidebar shows current Vault state at a glance:

| Pill | Meaning |
|------|---------|
| Green | Authenticated, token healthy |
| Amber | Token expires soon |
| Red | Not logged in or token expired |
| No pill | Vault integration disabled |

## Vault References

Once Vault is configured, any env-var value (global defaults, environment defaults, launch profiles, or per-session overrides) can be a Vault reference instead of a literal:

```
vault://secret/anthropic#api_key
```

Format: `vault://<mount>/<logical path>#<key>`

- The first segment is the KV mount; the rest is the logical secret path. Omit the KV v2 API's `/data/` segment — Tether adds it when making the request.
- The fragment after `#` is the key within that secret's data

At session start, Tether resolves every `vault://` reference in parallel via `vault-resolver.ts`. If any reference fails to resolve, the session does not start and you get a toast with the specific error (missing key, no permission, vault not reachable, etc.).

If Vault is not authenticated when a session with Vault refs is about to launch, Tether shows a **Vault login prompt** dialog before spawning.

## Picking Secrets from a Browser

In any env-var editor (Settings, the env editor for an environment, or the New Session dialog), click the **Vault** icon next to a value field to open the **Vault picker**. It browses your KV mount tree, lets you drill into a secret, and inserts the right `vault://...#key` reference into the field. No copy-pasting paths.

## Migrating Plaintext Secrets to Vault

**Settings → Integrations → Vault Integration → Migrate Existing Secrets…** lists supported local secrets, including SSH passwords, provider tokens, and sensitive env vars. Choose a secret and destination, then migrate it. Tether writes the value to Vault before replacing the local value with a `vault://` reference. Migration applies immediately.

## What Tether Stores Locally

In `data.json`:

- Vault config (enabled state, address, namespace, mount, OIDC role)
- Encrypted login token, identity, and expiry metadata
- `vault://` references in env-var values

Tether never persists raw secret values that come back from Vault. They're held in memory during the session and discarded when the session ends.
