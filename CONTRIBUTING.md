# Contributing to Tether

Thanks for helping improve Tether. Bug reports, documentation, tests, and focused
code changes are welcome. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions, bugs, and feature requests

Use [Discussions](https://github.com/maxthomas95/tether/discussions) for questions
and ideas, and [Issues](https://github.com/maxthomas95/tether/issues) for bugs and
feature requests. Search existing discussions and issues first. Discuss larger
changes with a maintainer before investing in an implementation.

For a bug report, include the Tether version, operating system, CLI tool and
version, environment (local, SSH, or Coder), steps to reproduce, and expected and
actual behavior. Screenshots or diagnostics can help, but review and redact them
before sharing: terminal output and logs may contain credentials, private source
code, hostnames, or personal information.

Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Set up a development checkout

Tether currently ships Windows builds. Use Node.js 24, Git, and npm. CI pins npm
10.9.4 for reproducible dependency installation.

Fork the repository, then clone your fork and create a feature branch:

```bash
git clone https://github.com/YOUR-USERNAME/tether.git
cd tether
git switch -c fix/describe-your-change
npx npm@10.9.4 ci
npm run start
```

Install the CLI tool you want to exercise separately. SSH, Coder, and Vault
credentials are only needed when testing those integrations; use your own test
environments. Keep credentials and local configuration out of commits.

Use a separate Git worktree when running parallel development sessions. Do not
make changes directly on `main`.

## Understand the project

Read [CLAUDE.md](CLAUDE.md) for architecture and conventions,
[AGENTS.md](AGENTS.md) for the concise operating guide, and the
[architecture](docs/ARCHITECTURE.md) and
[transport design](docs/TRANSPORT_DESIGN.md) docs for deeper context.

- Preserve **dumb pipe, smart shell**: PTY bytes flow unchanged into xterm.js.
  Status, hooks, notifications, and usage tracking are passive side channels.
- Keep transport and session lifecycle in Electron main, and UI state in the
  renderer. All transports implement `SessionTransport`.
- Put per-CLI flags, resume, and history behavior in `src/shared/cli-tools.ts`.
- Use platform-aware paths and direct process spawning. Gate platform-specific
  behavior explicitly.
- Preserve SSH host-key verification and secret-storage boundaries. Never log or
  commit private keys, passphrases, or tokens.
- Update the relevant [in-app documentation](src/docs/) alongside changes to
  user-visible behavior.

Keep changes focused. Avoid unrelated formatting, dependency updates, or
generated files. Include meaningful tests for behavior changes and regressions.

## Validate your changes

For application code changes, run:

```bash
npm run typecheck
npm run lint
npm test
npm run test:packaging
npm run test:security
```

Use `npm run test:coverage` when checking coverage; CI runs it and publishes the
results to SonarQube Cloud. For UI or Electron lifecycle changes, also launch the
app and exercise the affected behavior. Check keyboard interaction, focus, and
layout at different window sizes for UI changes.

For dependency or security changes, also run:

```bash
npm audit --audit-level=high
npm run audit:security
npm audit --omit=dev --audit-level=high
```

The raw root audit reports the temporary build-only `braces` finding even with
the backport installed. `audit:security` is CI's integrity-checked gate for that
specific mitigation; all other high/critical findings fail. Runtime and Helm
audits remain strict. Read [dependency security](docs/DEPENDENCY_SECURITY.md)
for scope, expiry, and removal requirements; never use `audit fix --force` to
silence a release gate.

For packaging changes, also run:

```bash
npm run package
npm run verify:package
npm run smoke:windows
```

The Windows smoke launches the actual package with disposable user data and a
local test CLI. It covers setup, settings persistence, ordinary terminal input,
PTY output/resize/Stop, shutdown, and restart without CLI accounts or remote
credentials. It uses loopback Chromium debugging only; packaged Electron
security fuses stay enabled. CI uploads bounded test diagnostics on failure.

When changing the Helm MCP server, install and validate its separate package:

```bash
npx npm@10.9.4 --prefix mcp-servers/tether-helm ci
npm --prefix mcp-servers/tether-helm run build
npm --prefix mcp-servers/tether-helm audit --audit-level=high
```

For documentation-only changes, check links, examples, and `git diff --check`.
Check README, architecture/transport guidance, roadmap, and shipped help for
related claims. `site/index.html` contains the public site's copy and deploys
through GitHub Pages when its changes merge. Archived specs and historical
changelog sections describe their original releases; update their navigation
when needed without rewriting history. For a release, follow [RELEASE.md](RELEASE.md)
and verify fresh-profile, previous-stable migration, native PTY input/stop, and
shipped docs in the packaged application.
The [CI workflow](.github/workflows/ci.yml) is the source of truth for automated
checks. State exactly which checks you ran and explain any skipped checks.

[CodeQL](.github/workflows/codeql.yml) scans every pull request to `main`,
including forks, without repository secrets or project build scripts. The
repository uses this workflow (advanced setup), rather than CodeQL default
setup, which skips fork pull requests. Keep the required `CodeQL` merge check
enabled. First-time contributors may still need a maintainer to approve their
Actions runs; their PRs do not need to be copied into this repository.

## GitHub automation

PRs run dependency review in addition to the app/Helm audits. New high or
critical dependency vulnerabilities fail the check. Same-repository PRs receive
an updated comment on failure; fork and Dependabot PRs use check summaries with
read-only tokens. The review never executes PR code or uses repository secrets.

Dependabot opens weekly grouped patch/minor updates, with at most two version
PRs per ecosystem. Major upgrades remain separate; security-update groups
remain enabled. Actions are pinned to reviewed full commit SHAs and maintained
by Dependabot. Sonar intentionally skips fork/Dependabot PRs because they cannot
access its token; do not introduce privileged PR checkouts to work around that.

Changes to main require a PR and the configured checks. The maintainer can
merge their own reviewed changes without a second-person approval requirement.
New check contexts should become required only after their workflows are on
main, so existing contributor branches are not stranded.

## Submit a pull request

Use a conventional commit subject such as `fix(ssh): handle reconnect cleanup`,
`feat: add a session option`, or `docs: clarify setup`. If an agent authors a
commit, include an appropriate `Co-authored-by` trailer.

Push your feature branch to your fork and open a pull request against Tether's
`main`. Repository collaborators should push branches to the `github` remote.
Use the [pull request template](.github/pull_request_template.md) and include:

- **Summary:** the problem, resulting behavior, and any persistence, transport,
  or security-boundary impact. Link related issues and include screenshots for
  visible UI changes.
- **Test plan:** commands actually run and relevant manual smoke checks.
- **Out of scope:** deliberately deferred work or known limitations.

Address review feedback and keep the branch current as needed. Maintainers merge
approved pull requests using squash merge; do not bypass protected `main`.

Contributions are made under the project's [MIT license](LICENSE).
