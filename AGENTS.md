# AGENTS.md - Tether

## Project Shape

Tether is an Electron + React + TypeScript desktop app for managing agent CLI
sessions across local, SSH, and Coder environments.

Use `CLAUDE.md` as the detailed architecture and convention source for this
checkout. Read the relevant sections before non-trivial implementation work.
This file is the concise Codex/agent operating guide.

Important files:

- `CLAUDE.md`: project architecture, current status, conventions, and file map.
- `package.json`: root app dependencies and scripts.
- `.github/workflows/ci.yml`: CI checks.
- `mcp-servers/tether-helm/package.json`: nested Helm MCP server package.
- `src/docs/*.md`: in-app docs that ship with the app.
- `src/shared/cli-tools.ts`: CLI registry and per-tool behavior.
- `src/main/transport/*`: local, SSH, Coder, and PTY transport boundaries.

## Core Principle

**Dumb pipe, smart shell.** Never parse, filter, intercept, or re-render CLI
output. PTY bytes flow byte-for-byte into xterm.js. Status detection,
notifications, hooks, and usage tracking must remain passive side-channel
features, not terminal renderers.

## Architecture Boundaries

- Electron main owns PTY lifecycle, transports, persistence, status detection,
  notifications, updates, Vault integration, usage aggregation, and host-key
  verification.
- The renderer owns React UI, xterm.js panes, dialogs, sidebar state, split
  layouts, keyboard shortcuts, and theming.
- All session transports implement `SessionTransport` from
  `src/main/transport/types.ts`.
- Per-CLI resume/history/flag behavior belongs in `src/shared/cli-tools.ts`.
- CLI flags may be stored as string presets, but tokenization happens at the
  transport boundary.
- JSON persistence under Electron `userData` is the current storage model;
  SQLite is deferred.

## Agent Routing

`.codex/agents/` (local, untracked) defines three model-tiered Codex
subagents. Route by task shape, not habit:

- `architect` (`gpt-5.5`, effort high) — bounded deep problems:
  root-causing a specific behavior, design analysis with non-obvious
  tradeoffs, and transport/status/IPC lifecycle debugging. Returns analysis
  with file:line evidence; does not usually write production code.
- `coder` (`gpt-5.5`, effort low) — implementation with a clear spec, known
  files, and a defined done-state. Ambiguous specs bounce back rather than get
  improvised. Bump effort only if the spec gets looser.
- `scout` (`gpt-5.4-mini`, effort low, read-only) — fast lookups,
  log/transcript digging, config checks, and quick verifications. Never edits
  files.

Standing rules:

1. **Discovery-shaped or cross-cutting work stays at the orchestrator level.**
   Problems nobody has framed yet — status-detection matrix bugs, transport
   lifecycle races, anything spanning main/renderer/IPC — cannot be specced for
   delegation until top-level review frames the problem.
2. Use custom subagents only when the user explicitly asks for subagents,
   parallel agents, delegation, or this routing behavior. Codex should not spawn
   them automatically for ordinary single-threaded work.
3. Escalate up-tier when a problem resists a bounded framing; never down-tier to
   save cost on something that keeps bouncing.
4. For ambiguous multi-step work, prefer a full spawned session that can pause
   and ask over a fire-and-forget subagent.

Implementation work still goes through isolated worktrees when parallel
sessions are active; at most, fan out independent well-specced cleanups to
parallel `coder` runs.

## Development Rules

- Preserve the raw terminal invariant for local, SSH, and Coder sessions.
- Background sessions keep their PTY connections live off-DOM with data flowing
  over IPC to the renderer, so scrollback survives re-attach; only active panes
  attach to the DOM. Do not add rendering or per-frame work for hidden sessions.
- Do not store private keys, passphrases, Vault tokens, API tokens, or other
  secrets in plaintext files or logs.
- Keep SSH host-key TOFU and known-host behavior secure from the first contact.
- Do not add public relay behavior without a separate security design.
- Keep UI state in renderer/view-model layers and transport lifecycle in
  transport/session layers.
- Use `path`, `os`, and Electron app paths for filesystem locations. Avoid
  hardcoded absolute paths and Windows-only assumptions unless gated.
- Invoke child processes directly with `spawn(cmd, args)` where practical.
  Avoid `shell: true` unless a platform-gated shell path is intentional.
- When adding or changing user-visible behavior, update the relevant in-app
  docs in `src/docs/*.md` in the same change.
- Stage only files relevant to the task. Do not disturb unrelated local edits.
- Treat planning or review markdown as local-only unless the user explicitly
  asks to commit it.

## Standard Validation

Before considering dependency or security work complete, run the relevant
subset of:

```bash
npm test
npm run lint
npx tsc --noEmit
npm audit --audit-level=high
```

Additional checks:

- Run `npm --prefix mcp-servers/tether-helm run build` when touching the Helm
  MCP server.
- Run focused app smoke checks when UI or Electron lifecycle behavior changes.
- Do not invent validation commands in PR descriptions. Report exactly what ran
  and call out anything skipped.

## Worktree and Branch Policy

- Never work directly on `main`; create a feature branch first.
- Prefer separate worktrees for substantial or risky tasks.
- GitHub is the source of truth; push branches to the `github` remote.
- `main` is protected; changes should go through branch, PR, and squash merge.
- If the tree is already dirty, identify unrelated edits and leave them alone.

## Commit and Pull Request Guidelines

- Use conventional commit prefixes: `feat:`, `fix(scope):`,
  `refactor(scope):`, `docs:`, `chore:`, and similar.
- Keep the subject to one line.
- In the body, explain what changed, why it changed, and any user-visible
  behavior, persistence/schema impact, transport impact, security boundary, or
  deliberately deferred work.
- End agent commits with an appropriate `Co-authored-by: <agent> <email>`
  trailer.
- PR bodies should include:
  - `## Summary`: user-visible behavior, persistence/schema impacts, transport
    impacts, and security boundaries.
  - `## Test plan`: checkboxes with commands actually run.
  - `## Out of scope`: deliberately deferred follow-up work.
- When squash-merging, use explicit `--subject` and `--body` to avoid duplicate
  trailers.
