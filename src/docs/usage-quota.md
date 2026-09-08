# Usage & Quota

Tether reads local CLI metadata and sanitized Claude Code/Codex usage records collected over SSH or Coder. Terminal output continues directly to the terminal; usage tracking does not intercept it. Costs are estimates at API rates, using a cached [LiteLLM](https://github.com/BerriAI/litellm) pricing table. They are not subscription bills.

## How It Works

| CLI | Source | Coverage |
|-----|--------|----------|
| Claude Code | Local or remote transcript JSONL | Input, output, cache creation and cache reads per event. |
| Codex CLI | Local or remote session JSONL under the Codex home | Token events, model, reasoning effort and reported context metadata when available. |
| OpenCode usage reader | Crush's local `crush.db` | Session snapshots; does not cover every OpenCode storage format. Exact event-day timing may be unavailable. |
| Copilot CLI | Not available | Its supported history source does not report token usage. |

The Crush reader checks `%LOCALAPPDATA%/crush/crush.db` on Windows and `~/.local/share/crush/crush.db` elsewhere. `CRUSH_GLOBAL_DATA` can override the directory. Claude transcript discovery respects `CLAUDE_CONFIG_DIR`.

Backfill runs at startup and filesystem watchers update local usage. Codex uses `CODEX_HOME` when set, otherwise `~/.codex`. Remote usage collection uses the existing authenticated connection; full transcripts stay on the host.

Codex cumulative counters prevent repeated token reports from being counted twice. Reasoning tokens are part of output tokens; the reasoning breakdown is not added to output or billed again. Cached input is separated from uncached input for cost calculations.

Daily totals use each event's UTC date. Resuming a conversation on another day does not move its earlier usage to the new day. Tether rebuilds older summaries from available transcripts once. Remote summaries are rebuilt on the next successful collection; failures retain the previous lifetime totals. If the source is missing, historical lifetime totals remain available with unknown daily timing. Snapshot-based sources are marked approximate. Session counts count unique conversations across the selected period.

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

The pane footer shows available usage and an API-equivalent cost estimate. Click its details control to inspect the native conversation ID, working directory, environment, launch profile and tracking coverage.

For Codex, details distinguish requested launch overrides from the latest observed model and reasoning effort. The last reported request size and context-window capacity are shown when available. This is a transcript observation, not a live measurement of remaining context. Missing metadata is labelled unavailable instead of being presented as a measured zero.

Optional lifecycle hooks add last-hook time, approvals, compaction counts and active subagent IDs. Counts cover events observed during the current Tether session. See [Codex settings](settings.md#codex).

## Global Usage Footer

The sidebar footer shows today's cost and a seven-day sparkline. Click it to open usage history. Tool and environment breakdowns describe attributed local and remote observations; unattributed backfill remains separate.

## Usage History Dialog

Filter by CLI, project, environment, model and UTC date range. Compare the selected period with the preceding period of the same length, inspect the daily trend and click a day to narrow the session ledger.

The sortable ledger expands into per-model input, output, cache and reasoning breakdowns. Model and date filters use the matching daily model usage rather than a conversation's entire lifetime. Unknown daily timing is included only in all-time views and is labelled; approximate snapshots remain distinguishable. No conversation text is displayed.

## Budget Guardrails

[Settings -> Usage](settings.md#usage) has optional **Daily budget warning (USD)** and **Weekly budget warning (USD)** thresholds. Blank or `0` disables a warning.

Daily warnings use the UTC calendar day; weekly warnings use Monday-Sunday UTC. When tracked usage crosses a threshold, Tether shows an in-app warning and turns the usage footer amber. The last-warning period is saved locally to avoid repeating a warning after restart. These warnings do not change provider limits.

## Export

[Settings -> Usage](settings.md#usage) provides **Export as CSV** and **Export as JSON**. CSV contains a row per session. JSON includes per-session and per-model totals, daily buckets, timing coverage, working directories and environment IDs. Both ask for a save location; exports contain usage metadata, not conversation text.

## Quota Tracking

Enable **Show usage quota in sidebar** (on by default) in [Settings -> Usage](settings.md#usage). The sidebar shows the percentage left and the next reported reset. Quota polling starts shortly after launch and refreshes every five minutes; click the footer to refresh.

Codex quota uses the installed Codex CLI's supported app-server interface. Tether shows reported quota buckets with their actual window durations and retains the last successful observation when a refresh fails. A last-known reading is labelled with its observation time. Availability depends on the installed CLI, sign-in and account mode.

Set **Codex quota warning** in [Settings -> Codex](settings.md#codex) to a remaining-percentage threshold. `0` disables notifications. Fresh successful measurements at or below the threshold produce one in-app warning per reported window reset. Stale, failed, expired and unknown measurements do not trigger warnings. Subscription quota must be enabled.

## Codex Account Usage

[Settings -> Codex](settings.md#codex) has an explicit **Load account usage** action. It displays the account-wide token summary, daily trend, streaks, longest turn and quota windows that Codex reports. These figures have a different scope from Tether's local session estimates and are never added to them. Unsupported methods or unavailable account fields are labelled. Opening Settings alone does not request account usage.

## Privacy

Local transcript files are read locally. For SSH and Coder sessions, prompts and
responses stay on the remote host: the reader sends only model names, reasoning
effort, token counts, context capacity, timestamps, and source/cursor metadata over the authenticated connection.
Tether persists summaries and read positions, never conversation text or resolved
passwords. No usage data is uploaded to a third-party analytics service.

Its pricing table may refresh once a day from `raw.githubusercontent.com`. Optional quota refreshes contact providers; Codex requests use the installed CLI. Explicit account/configuration inspection may also contact provider services through Codex. Tether does not send prompts through these read-only requests or copy Codex credentials into its renderer, files or logs.

The configuration inspector exposes only selected settings, source categories, native profile names and integration names. Commands, URLs, environment values and authentication payloads are omitted. Exports include project paths and IDs, so choose their destination accordingly.
