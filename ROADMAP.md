# Roadmap — Tether

The next milestone is a polished **1.0 for Windows**. Stable releases graduate a beta that has worked well in ordinary use; they do not need to wait for every 1.0 goal. Feature work, fixes, and dependency updates share `main`, with beta save points and protected release PRs. See [Releasing](RELEASE.md).

## 0.7.0 stable milestone

This milestone brings the 0.6.x beta train to stable. The [changelog](CHANGELOG.md) records its release scope; the [user guide](src/docs/getting-started.md) describes current behavior.

- **Workspaces:** single/split/Canvas layouts, keyboard navigation, broadcast input in splits, terminal search, session search, attention queue, recent projects, encrypted launch restore, and named workspace recipes.
- **Remote work:** SSH/Coder conversation recovery, Claude/Codex usage collection, SSH status-hook opt-in, secure echo-off launch configuration, and remote Claude child-agent viewers.
- **CLI integration:** shared per-tool settings, guided launch controls, native version/update terminals, Codex account/quota inspection, optional trusted local lifecycle hooks, and local `codex exec` child rows.
- **Interface:** eleven themes, bundled fonts and previews, independent UI density, stable attention controls, optional GIF panel and Pip, and explicit J.O.B.S. connection/sharing controls.
- **Reliability and security:** encrypted credential migration and launch snapshots, sandboxed preloads/Office view, authenticated hook/Helm bridges, hardened clipboard/link handling, packaged Windows ConPTY shutdown, and enforced CI/package/security checks.
- **Documentation:** reconcile README, architecture, transport guidance, release/contributor docs, shipped help, and the public site's copy with the implemented release.

## Before Windows 1.0

### Validate daily workflows

- Continue exercising fresh setup, upgrades from the previous stable, workspace restore, recipes, session duplication, Stop/restart, and clean shutdown in packaged builds.
- Validate ordinary typing, multiline input, clipboard, search, resize, focus, and mixed-CLI broadcast across the supported terminal modes. Do not treat a focused shortcut test as complete input coverage.
- Exercise live SSH/Coder recovery with present/missing history, concurrent conversations, sudo, unavailable remote Node, and connection loss. Automated fixtures do not establish every live-host behavior.
- Retain experimental labels for split/Canvas layouts and lifecycle visibility until their limits are deliberately reviewed. Helm stays optional and outside the 1.0 critical path.

### Keep status and usage trustworthy

- Investigate new status/attention regressions using live traces across CLI, transport, and hook settings. Cadence-only status remains an estimate, especially for quiet model calls or child agents.
- Keep event-day accounting, request/compaction deduplication, per-model/environment attribution, and unknown daily timing explicit in usage UI and exports.
- **Copilot cost tracking remains blocked:** there is no supported cost reader. Inspect an installed CLI's persisted usage format before proposing ingestion; resume and transcript browsing already work.
- OpenCode usage covers the supported local Crush database, not all OpenCode storage formats. Remote OpenCode usage and broader format coverage remain unimplemented.

### Release and desktop quality

- Resolve the temporary build-only `braces` mitigation before its **2026-11-04** expiry; keep [runtime/Helm audits strict](docs/DEPENDENCY_SECURITY.md).
- Preserve packaged ASAR/resource verification, native PTY startup/stop smoke, credential migration failure recovery, and the required exact-head CI/CodeQL checks. Review Sonar's actual gate, not just scan-job completion.
- Make an explicit signing decision for Windows 1.0. Current Windows installer/portable releases are unsigned. See the [1.0 release checklist](docs/1.0_RELEASE_CHECKLIST.md).
- Continue keyboard, focus, screen-reader, responsive-layout, light/dark-theme, and reduced-motion review. Keep shipped help and GitHub documentation aligned with visible controls.

## Deferred until after 1.0

- **macOS and Linux desktop builds:** package, sign/notarize where appropriate, and validate install/update and native terminal behavior. Existing path/platform hygiene does not imply these builds are supported today.
- **Coder remote status-hook installation:** currently deferred; Coder terminal status and child activity fall back to cadence/transcript estimates.
- **Persistence changes:** consider a usage/transcript index through built-in `node:sqlite` only if history scale or query performance warrants it. App configuration remains atomic JSON.
- **Pinned sessions:** a possible follow-up for keeping selected sessions at the top of their group.

Historical plans live under [docs/archive](docs/archive/). They are frozen specifications, not a current feature contract. Completed release history belongs in [CHANGELOG.md](CHANGELOG.md).
