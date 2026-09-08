# Usage & Quota

Tether tracks per-session and global token usage and cost for Claude Code, Codex CLI, and OpenCode sessions. There's no agent-side instrumentation — usage is computed from the CLI's own transcript files (or OpenCode's local DB) using a vendored copy of [LiteLLM](https://github.com/BerriAI/litellm)'s pricing table.

## How It Works

| CLI | Source | Notes |
|-----|--------|-------|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | Sums input / output / cache-create / cache-read tokens per event. |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | Tracks active model from `turn_context` and sums `last_token_usage` deltas from `token_count` events. |
| OpenCode | `crush.db` (local SQLite) | Reads pre-computed cost per session; no token-level math. |
| Copilot CLI | *(not supported)* | Blocked on upstream — `events.jsonl` doesn't persist token usage. See ROADMAP. |

Backfill runs at startup; live updates piggyback on filesystem watchers. Pricing data lives at `{userData}/litellm-prices.json` and refreshes at most once a day from `raw.githubusercontent.com`.

### SSH and Coder sessions

Claude Code and Codex sessions launched through Tether also collect usage on remote
hosts. Totals appear in the same pane strip, environment breakdown, history,
budget warnings, and CSV/JSON exports as local sessions.

Tether reads new transcript records over a separate authenticated connection,
normally every 10 seconds. It saves usage totals and the read position locally so
a dropped connection can catch up without counting the same records twice. This
works independently of the **CLI status hooks** settings and does not install a
helper or modify the remote CLI's configuration. Coder collection uses its CLI's
command mode and does not start stopped workspaces.

Requirements and limits:

- The remote host needs `node` or `nodejs` on its login-shell PATH. Claude
  collection supports POSIX hosts. Automatic Codex session matching currently
  requires Linux and permission to read that user's process information in
  `/proc`. Tether matches the CLI's open transcript instead of guessing from the
  directory, so concurrent sessions cannot take each other's usage.
- `HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` overrides set in the session's
  environment are honored. For SSH sessions using **sudo**, collection runs as
  the elevated user too. It uses noninteractive sudo or the configured SSH
  password through encrypted stdin; policies requiring a TTY or a different
  sudo password leave usage unavailable without interrupting the terminal.
- Collection begins when a transcript is available, often after the first
  prompt. The pane shows **Waiting for remote usage** until it is found. A Codex
  process that exits before discovery may have no collected usage. Ambiguous
  matches stay pending.
- Connection or reader failures retry automatically. **Last collected** means
  the displayed totals may be stale; hover for details. History retains the last
  successfully collected totals after disconnection or exit.
- This collects conversations launched in Tether, not all historical sessions
  on the remote host or separate subagent transcripts. Remote transcript browsing
  and resume behavior are unchanged. Remote OpenCode usage is not yet supported.

## Per-Session Cost Strip

For a session with a known conversation ID, the footer shows the model, message count, and cost labeled **API equivalent**. This estimate is not your subscription bill. Hover for token and model details. If usage has not arrived, the strip says **Usage unavailable** instead of presenting a measured zero.

## Global Usage Footer

The bottom of the sidebar shows today's cost and a 7-day sparkline (`GlobalUsageFooter`). Click it to open the **Usage history** dialog.

## Budget Guardrails

[Settings -> Usage](settings#usage) has optional **Daily budget warning (USD)**
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

[Settings → Usage](settings#usage) has two export buttons:

- **Export as CSV…** — one row per session with totals. RFC 4180 quoting; safe to drop into Excel or analytics tooling.
- **Export as JSON…** — full structure: per-session, per-model breakdowns, daily rollups, working directory, environment ID, and the current Tether version.

Both serialize via `src/main/usage/usage-exporter.ts` and prompt for a save location.

## Quota Tracking

Bar values explicitly show the percentage **left**, for example **63% left**. Reset times are shown alongside the bars when available. Hover for both used and remaining percentages.

Optional. If you're on an Anthropic Pro / Max or OpenAI Plus subscription, Tether can poll the provider's quota endpoint and surface remaining budget in the sidebar footer (`QuotaFooter`).

Toggle it on in [Settings → Usage → Subscription quota](settings#usage). Disable if you're on metered API billing instead — the poll just adds noise.

When the quota service is enabled, it polls on a short timer at startup (5s delay) and refreshes periodically. Failures are silent and won't block startup.

## Privacy

Local transcript files are read locally. For SSH and Coder sessions, prompts and
responses stay on the remote host: the reader sends only model names, token
counts, timestamps, and source/cursor metadata over the authenticated connection.
Tether persists summaries and read positions, never conversation text or resolved
passwords. No usage data is uploaded to a third-party analytics service. Pricing
refreshes make one HTTP GET per day to `raw.githubusercontent.com`; optional
subscription quota tracking also contacts the provider's quota endpoint.
