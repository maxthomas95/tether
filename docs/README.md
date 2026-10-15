# Tether documentation

The current Windows release is documented in the [changelog](../CHANGELOG.md).
Download [stable builds](https://github.com/maxthomas95/tether/releases/latest)
or select the Beta channel for prereleases.

## User guide

These pages also ship in **Help → Documentation**. Relative Markdown links work
both on GitHub and inside Tether.

- [Getting started](../src/docs/getting-started.md) — installation, setup and layouts.
- [Sessions](../src/docs/sessions.md) — launch, resume, restore, recipes, search and child viewers.
- [Environments](../src/docs/environments.md) — local, SSH and Coder requirements.
- [Settings](../src/docs/settings.md) — all nine sections, defaults and consent controls.
- [Keyboard shortcuts](../src/docs/keyboard-shortcuts.md) — navigation, clipboard and multiline input.
- [Usage and quota](../src/docs/usage-quota.md) — estimates, remote collection, exports and privacy.
- [Vault](../src/docs/vault.md), [Git providers](../src/docs/git-providers.md) and [Helm](../src/docs/helm.md).

## Development and releases

- [Architecture](ARCHITECTURE.md) — ownership, lifecycle, persistence and side channels.
- [Transport design](TRANSPORT_DESIGN.md) — native PTY and remote launch boundaries.
- [Contributing](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).
- [Release process](../RELEASE.md), [1.0 checklist](1.0_RELEASE_CHECKLIST.md) and [roadmap](../ROADMAP.md).
- [Dependency security](DEPENDENCY_SECURITY.md), [Sonar and coverage](SONAR.md) and [security reporting](../SECURITY.md).
- [Helm server package](../mcp-servers/tether-helm/README.md).

The public website's source is [site/index.html](../site/index.html), deployed by
[GitHub Pages](../.github/workflows/pages.yml) when site changes merge to main.
Historical specifications under [archive](archive/) are frozen; their claims do
not describe the current release. Exact versions, commands and interfaces live
in package manifests, CI, and the source files linked by each guide.
