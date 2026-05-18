# Helm

Helm is an **opt-in, experimental** capability that lets a designated "parent" session dispatch pre-briefed child sessions through an MCP server (`tether-helm`). It's the in-progress evolution of multi-agent orchestration inside Tether — currently personal-experimental, not a polished feature.

## Status

Helm is intentionally low-key. There is no flagship UI for it yet, and it isn't on the 1.0 critical path. The feature stays behind a per-session toggle so it doesn't affect anyone who hasn't opted in.

If you're not actively trying to use Helm, you can ignore this page.

## Enabling Helm on a Session

1. Right-click a session in the sidebar
2. Choose **Enable Helm**
3. Tether configures the session to expose the `tether-helm` MCP, which gives the CLI tools for spawning child sessions, listing them, and brokering messages

The toggle is persisted on the session record; you can disable it the same way.

## What Helm Does (today)

- Adds Tether-aware MCP tools for the parent session
- Spawns child sessions with the same environment / repos root / CLI as the parent, plus a brief
- Routes status and exit signals between parent and children

## What Helm Does **Not** Do

- It does not bypass the per-CLI cost cap or quota
- It does not give children network access the parent doesn't have
- It does not orchestrate beyond the explicit dispatch — there is no scheduler

## Why It's Opt-In

The roadmap principle is "dumb pipe, smart shell" — Tether deliberately avoids agent orchestration as a built-in feature. Helm is the carve-out for users who want it, kept behind a per-session toggle so it doesn't change the default Tether experience.

Expect changes; this page will get longer as Helm stabilizes.
