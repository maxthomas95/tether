# Security Policy

## Supported versions

Security fixes target the latest stable Tether release. Upgrade to the latest
release before reporting an issue when practical, but report suspected
vulnerabilities even if you cannot upgrade.

| Version | Security support |
| --- | --- |
| Latest stable release | Receives security fixes |
| Latest beta release and `main` | Reports welcome; fixes on a best-effort basis |
| Older releases | No guaranteed backports; upgrade to the latest stable release |

Available builds are listed on the
[Releases page](https://github.com/maxthomas95/tether/releases).

## Report a vulnerability privately

Email **[max@thomashomecompany.com](mailto:max@thomashomecompany.com)** with the
subject **Tether security report**.

Do not disclose vulnerability details in public issues, discussions, or pull
requests before a fix or coordinated disclosure. Use private email for the
initial report. For sensitive material, ask to arrange a suitable transfer
method before sending it.

Include as much of the following as you can:

- Affected Tether version or commit, operating system, and environment (local,
  SSH, or Coder).
- A description of the vulnerability, its impact, and any required access or
  configuration.
- Reproduction steps or a minimal proof of concept using test data.
- Relevant logs or screenshots with secrets and personal information removed.
- Suggested mitigations or fixes, if available, and whether you would like
  public credit.

Never send live private keys, passphrases, Vault tokens, API tokens, or other
credentials. Review diagnostic bundles and terminal output before sharing them.

## What happens next

The maintainer will review the report, request any additional information needed,
and coordinate validation, mitigation, a fix, and disclosure with the reporter.
Response and release timing depend on severity and maintainer availability;
there is no guaranteed response or remediation deadline. Please follow up by
email if you have not received a response.

Please coordinate public disclosure so users have a chance to update. Confirm
whether you want credit before an advisory or release note is published.

## Scope

This policy covers Tether's desktop app, Electron IPC and renderer boundaries,
local/SSH/Coder transports, credential handling and Vault integration, update
and packaging paths, and the bundled Helm MCP server. Dependency vulnerabilities
that affect Tether are also welcome reports.

Tether launches external CLI tools using the permissions of the selected local
or remote account. It does not sandbox those tools or replace their permission
controls. Report vulnerabilities in an external CLI or service to its own
maintainers; report failures in Tether's integration here.

Test only against systems and accounts you own or have permission to assess,
using disposable data where possible.

For ordinary bugs and support questions, use
[Issues](https://github.com/maxthomas95/tether/issues) or
[Discussions](https://github.com/maxthomas95/tether/discussions).
