# Git Providers

Tether can browse and clone from **GitHub**, **Azure DevOps**, and **Gitea**, and can provision empty repos on each when you create a new folder. Register your provider credentials in [Settings → Integrations → Git providers](settings#integrations) and they show up in the **Clone** and **New folder** tabs of the New Session dialog.

## Registering a Provider

For each provider you need:

- **Display name** — what shows in dropdowns
- **API base URL** — `https://api.github.com`, `https://dev.azure.com/<org>`, or your self-hosted Gitea URL
- **Auth token** — a personal access token with `repo`-equivalent scope on that provider

Tokens are stored in `data.json`. For best practice, store the token in [Vault](vault) and reference it from the provider config.

### GitHub

PAT scopes needed: `repo` (or fine-grained equivalents). Both `github.com` and GitHub Enterprise are supported — point the API base URL at your Enterprise instance.

### Azure DevOps

PAT scopes needed: **Code (read & write)**, **Project and team (read)**. The base URL should include your organization (e.g. `https://dev.azure.com/contoso`). You can optionally pick a **default project** from the loaded project list — this pre-selects when creating a new repo.

### Gitea

PAT with `repo` scope. Point the base URL at your Gitea instance (e.g. `https://gitea.internal/api/v1`).

After saving, click **Test connection** to verify the token works against the API.

## Cloning a Repo

In the New Session dialog, switch to the **Clone** tab:

1. Pick a provider from the dropdown
2. Search or browse the loaded repo list (paginated)
3. Pick a destination — Tether suggests `<reposRoot>/<repo-name>` but you can change it
4. Click **Clone**

Clone progress streams into the dialog. Once finished, the cloned directory becomes the session's working directory.

## New Folder

The **New folder** tab is the fastest way to start a brand new project. It is Local-only (the working directory must exist on your machine).

1. Type a folder name. Tether will create it under your **repos root**.
2. Optionally tick **Initialize git repo** to `git init` the new folder.
3. Optionally tick **Create remote repo on…** and pick a provider. Tether will:
   - Create an empty repo on the provider (private by default; flip the toggle for public)
   - Add it as `origin` on the local repo
   - Leave the first push to you (so you can pick when to publish)

The folder is then used as the session's working directory like normal.

### Remote-first ordering

If you opt into remote creation, Tether creates the remote **first**, then the local folder, then wires the remote. If the remote create fails, the local folder is never created, so you don't end up with an orphan directory pointing at a non-existent remote.

### ADO default project

If you've picked a **default project** in the ADO provider config, it's pre-selected here. Switch projects per-create from the dropdown.

## What Tether Stores

In `data.json`:

- Provider display name, API base URL, auth method
- Token (plaintext **unless** you used a Vault reference)
- Per-provider preferences like ADO default project

Tokens are scrubbed from the [diagnostics export](settings#diagnostics-export) for support bundles.
