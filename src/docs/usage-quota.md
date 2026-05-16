# Usage & Quota

Tether tracks per-session and global token usage and cost for Claude Code, Codex CLI, and OpenCode sessions. There's no agent-side instrumentation — usage is computed from the CLI's own transcript files (or OpenCode's local DB) using a vendored copy of [LiteLLM](https://github.com/BerriAI/litellm)'s pricing table.

## How It Works

| CLI | Source | Notes |
|-----|--------|-------|
| Claude Code | `~/.claude/projects/**/transcripts/*.jsonl` | Sums input / output / cache-create / cache-read tokens per event. |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | Tracks active model from `turn_context` and sums `last_token_usage` deltas from `token_count` events. |
| OpenCode | `crush.db` (local SQLite) | Reads pre-computed cost per session; no token-level math. |
| Copilot CLI | *(not supported)* | Blocked on upstream — `events.jsonl` doesn't persist token usage. See ROADMAP. |

Backfill runs at startup; live updates piggyback on filesystem watchers. Pricing data lives at `{userData}/litellm-prices.json` and refreshes at most once a day from `raw.githubusercontent.com`.

## Per-Session Cost Strip

Each terminal pane shows a footer strip with that session's cumulative cost and token counts (`PaneStatusStrip`). Hover for a breakdown by model.

## Global Usage Footer

The bottom of the sidebar shows today's cost and a 7-day sparkline (`GlobalUsageFooter`). Click it to open the **Usage history** dialog.

## Usage History Dialog

Tiles for **Today / 7d / 30d / All-time** cost and token counts, plus tabbed tables:

- **Daily** — last 30 days, one row per day
- **Weekly** — last 12 weeks (ISO weeks, Mon start)
- **Monthly** — last 12 months

All rollup math is pure renderer-side; no extra IPC calls.

### Per-environment attribution

The footer tooltip groups today's cost by environment ID (sorted, with an "Unattributed" bucket for backfilled or out-of-band sessions). Useful when you split work across Local / SSH / Coder and want to know which deployment is burning the budget.

## Export

[Settings → Usage](settings#usage) has two export buttons:

- **Export as CSV…** — one row per session with totals. RFC 4180 quoting; safe to drop into Excel or analytics tooling.
- **Export as JSON…** — full structure: per-session, per-model breakdowns, daily rollups, working directory, environment ID, and the current Tether version.

Both serialize via `src/main/usage/usage-exporter.ts` and prompt for a save location.

## Quota Tracking

Optional. If you're on an Anthropic Pro / Max or OpenAI Plus subscription, Tether can poll the provider's quota endpoint and surface remaining budget in the sidebar footer (`QuotaFooter`).

Toggle it on in [Settings → Usage → Subscription quota](settings#usage). Disable if you're on metered API billing instead — the poll just adds noise.

When the quota service is enabled, it polls on a short timer at startup (5s delay) and refreshes periodically. Failures are silent and won't block startup.

## Privacy

Transcript files stay on your machine. Tether only reads them locally — nothing is uploaded. The pricing JSON refresh is the only network call this feature makes (one HTTP GET per day, to `raw.githubusercontent.com`).
