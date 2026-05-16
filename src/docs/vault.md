# Vault

Tether integrates with [HashiCorp Vault](https://www.vaultproject.io/) so you don't have to store API keys or other secrets in plaintext. Env-var values can be `vault://` references that resolve to the actual secret at session start.

## Setup

Configure Vault in [Settings → Integrations → Vault](settings#integrations).

You need:

- **Vault address** — e.g. `https://vault.example.com:8200`
- **Namespace** *(optional)* — for Vault Enterprise multi-tenancy
- **KV mount** — defaults to `secret` (the KV v2 mount path)
- **Auth method** — token or OIDC

### Token auth

Paste a token, or point Tether at a file path that contains one. Tether stores the *path*, not the raw token. The token must have read access to the KV paths you want to reference. Tether will warn you in advance if the token is close to expiring.

### OIDC auth

Click **Login with OIDC**. Tether opens your browser to your Vault OIDC role's auth endpoint; once you've authenticated there, Vault redirects back with a token that Tether captures and uses going forward. The token is held in memory and refreshed transparently as needed.

A status pill in the sidebar shows current Vault state at a glance:

| Pill | Meaning |
|------|---------|
| Green | Authenticated, token healthy |
| Amber | Token expires soon |
| Red | Not logged in or token expired |
| Gray | Vault not configured |

## Vault References

Once Vault is configured, any env-var value (global defaults, environment defaults, launch profiles, or per-session overrides) can be a Vault reference instead of a literal:

```
vault://secret/data/anthropic#api_key
```

Format: `vault://<KV path>#<key>`

- The path is whatever you'd `vault kv get` (Tether handles the `/data/` segment that KV v2 inserts)
- The fragment after `#` is the key within that secret's data

At session start, Tether resolves every `vault://` reference in parallel via `vault-resolver.ts`. If any reference fails to resolve, the session does not start and you get a toast with the specific error (missing key, no permission, vault not reachable, etc.).

If Vault is not authenticated when a session with Vault refs is about to launch, Tether shows a **Vault login prompt** dialog before spawning.

## Picking Secrets from a Browser

In any env-var editor (Settings, the env editor for an environment, or the New Session dialog), click the **Vault** icon next to a value field to open the **Vault picker**. It browses your KV mount tree, lets you drill into a secret, and inserts the right `vault://...#key` reference into the field. No copy-pasting paths.

## Migrating Plaintext Secrets to Vault

Settings → Integrations → Vault has a **Migrate plaintext env vars** button. Tether scans your existing env-var values for ones that look like secrets, asks where to write them, copies them up to Vault, and rewrites the local value to a `vault://` reference. Originals are preserved until you confirm.

## What Tether Stores Locally

In `data.json`:

- Vault config (address, namespace, mount, auth method)
- Token *path* if you used file-based token auth (never the raw token)
- `vault://` references in env-var values

Tether never persists raw secret values that come back from Vault. They're held in memory during the session and discarded when the session ends.
