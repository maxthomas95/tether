# Usage & Quota

Tether tracks per-session and global token usage and cost from local CLI data. Claude Code and Codex CLI estimates use a bundled [LiteLLM](https://github.com/BerriAI/litellm) pricing table. The OpenCode usage reader supports the Crush database described below. These are API-equivalent estimates, not subscription bills.

## How It Works

| CLI | Source | Notes |
|-----|--------|-------|
| Claude Code | `~/.claude/projects/<encoded-directory>/<session-id>.jsonl` | Sums input / output / cache-create / cache-read tokens per event. Respects `CLAUDE_CONFIG_DIR`. |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | Tracks active model from `turn_context` and sums `last_token_usage` deltas from `token_count` events. |
| OpenCode usage reader | Crush's `crush.db` (local SQLite) | Reads stored cost and token totals. This reader does not cover every OpenCode storage format. |
| Copilot CLI | *(not supported)* | Tether currently has no Copilot cost reader. Resume and transcript browsing work independently. |

The Crush reader looks in `%LOCALAPPDATA%/crush/crush.db` on Windows, or `~/.local/share/crush/crush.db` on other platforms. `CRUSH_GLOBAL_DATA` can override the directory. If the database is missing or incompatible, it returns no usage. SSH and Coder transcripts are not downloaded for usage tracking.

Backfill runs at startup; live updates piggyback on filesystem watchers. Pricing data lives at `{userData}/litellm-prices.json` and refreshes at most once a day from `raw.githubusercontent.com`.

## Per-Session Cost Strip

For a session with a known conversation ID, the footer shows the model, message count, and cost labeled **API equivalent**. This estimate is not your subscription bill. Hover for token and model details. If usage has not arrived, the strip says **Usage unavailable** instead of presenting a measured zero.

## Global Usage Footer

The bottom of the sidebar shows today's cost and a 7-day sparkline (`GlobalUsageFooter`). Click it to open the **Usage history** dialog.

## Budget Guardrails

[Settings -> Usage](settings.md#usage) has optional **Daily budget warning (USD)**
and **Weekly budget warning (USD)** thresholds. Blank or `0` disables a
guardrail; positive decimal dollar values enable it.

Daily warnings use the current UTC calendar day. Weekly warnings use the current
ISO week, Monday-Sunday in UTC, matching the weekly usage-history rollups. When
usage crosses a configured threshold, Tether shows one in-app warning toast for
that period and turns the global usage footer amber while crossed. The
last-warning period is saved locally, so restarting Tether does not repeat the
same daily or weekly warning.

These guardrails use Tether's local API-equivalent cost estimates. They are not
provider billing data and do not change subscription or API limits.

## Usage History Dialog

Tiles for **Today / 7d / 30d / All-time** cost and token counts, plus tabbed tables:

- **Daily** — last 30 days, one row per day
- **Weekly** — last 12 weeks (ISO weeks, Mon start)
- **Monthly** — last 12 months

All rollup math is pure renderer-side; no extra IPC calls.

### Per-environment attribution

The footer tooltip groups today's cost by environment ID (sorted, with an "Unattributed" bucket for backfilled or out-of-band sessions). Useful when you split work across Local / SSH / Coder and want to know which deployment is burning the budget.

## Export

[Settings → Usage](settings.md#usage) has two export buttons:

- **Export as CSV…** — one row per session with totals. RFC 4180 quoting; safe to drop into Excel or analytics tooling.
- **Export as JSON…** — full structure: per-session, per-model breakdowns, daily rollups, working directory, environment ID, and the current Tether version.

Both serialize via `src/main/usage/usage-exporter.ts` and prompt for a save location.

## Quota Tracking

Bar values explicitly show the percentage **left**, for example **63% left**. Reset times are shown alongside the bars when available. Hover for both used and remaining percentages.

Optional. If you're on an Anthropic Pro / Max or OpenAI Plus subscription, Tether can poll the provider's quota endpoint and surface remaining budget in the sidebar footer (`QuotaFooter`).

**Show usage quota in sidebar** in [Settings → Usage](settings.md#usage) is on by default. Disabling it stops quota polling. It uses the Claude/Codex login credentials available on your machine; it is separate from local usage collection and cost-display toggles.

When enabled, polling starts about 5 seconds after launch and refreshes every 5 minutes. Failures do not block startup.

## Privacy

Usage collection reads local files without uploading transcripts. Pricing refresh downloads JSON from `raw.githubusercontent.com` at most once a day. Subscription quota is a separate network feature: it contacts `api.anthropic.com` and `chatgpt.com` with the corresponding local login credentials, and may refresh Claude credentials via `platform.claude.com`.
