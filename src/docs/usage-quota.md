# Usage & Quota

Tether reads local CLI metadata and sanitized Claude Code/Codex usage records collected over SSH or Coder. Terminal output continues directly to the terminal; usage tracking does not intercept it. Claude Code and Codex costs are estimates at API rates, using a cached [LiteLLM](https://github.com/BerriAI/litellm) pricing table. Native OpenCode and legacy Crush costs are reported by those CLIs. Neither source represents a subscription invoice.

## How It Works

| CLI | Source | Coverage |
|-----|--------|----------|
| Claude Code | Local or remote transcript JSONL | Input, output, cache creation and cache reads per event. |
| Codex CLI | Local or remote session JSONL under the Codex home | Token events, model, reasoning effort and reported context metadata when available. |
| OpenCode | Native local SQLite database | Completed `step-finish` records with provider/model, input, output, cache and reasoning tokens, and CLI-reported cost. |
| Legacy Crush | Local `crush.db` | Session snapshots with CLI-reported cost; exact event-day timing may be unavailable. |
| Copilot CLI | Not available | Its supported history source does not report token usage. |

The Crush reader checks `%LOCALAPPDATA%/crush/crush.db` on Windows and `~/.local/share/crush/crush.db` elsewhere. `CRUSH_GLOBAL_DATA` can override the directory. Claude transcript discovery respects `CLAUDE_CONFIG_DIR`.

Backfill runs at startup and filesystem watchers update local Claude Code and Codex usage. Codex uses `CODEX_HOME` when set, otherwise `~/.codex`. Remote usage uses a separate authenticated command connection and returns usage fields rather than full messages. SSH keeps a resident reader per connection, so an elevated host authenticates when it starts rather than for every poll. Coder usage uses command mode per poll; its separate child-agent reader is resident.

Codex uses per-request usage records when available, including compaction requests that may be absent from context token events. A separate request checkpoint prevents repeated records from being counted twice across app restarts. Older transcripts continue to use cumulative token events. A subagent's local rollout is counted separately from its parent's copied history. Reasoning tokens are part of output tokens; the reasoning breakdown is not added to output or billed again. Cached input and reported cache writes are separated from uncached input for cost calculations.

Daily totals use each event's UTC date. Resuming a conversation on another day does not move its earlier usage to the new day. Tether rebuilds older summaries from available transcripts once. Remote summaries are rebuilt on the next successful collection; failures retain the previous lifetime totals. If the source is missing, historical lifetime totals remain available with unknown daily timing. Snapshot-based sources are marked approximate. Session counts count unique conversations across the selected period.

### Local OpenCode sessions

Tether locates the native database using launch overrides and the supported native source layout, then reads the SQLite `session`, `message` and `part` tables without modifying them. For sessions launched through Tether, path discovery uses the effective launch environment, including `OPENCODE_DB`, `XDG_DATA_HOME`, home-directory overrides and supported channel-specific database selection (`OPENCODE_DISABLE_CHANNEL_DB`). An uncertain channel or source location leaves usage unavailable. Relative paths use the session's working directory. Startup backfill uses Tether's application environment; active local OpenCode sessions refresh every 10 seconds.

Usage comes from completed `step-finish` records, rather than combining message totals that can repeat or overwrite earlier steps. Provider and model identify each breakdown. Cache reads and writes are separate from input tokens; reasoning tokens are included in output with a separate reasoning breakdown. Costs use OpenCode's reported amounts, including a true zero, and are labelled **CLI reported**. They are not recalculated at API rates or treated as subscription invoices. Legacy Crush snapshots remain supported separately.

Copied fork history is excluded when timestamps identify it. Ambiguous fork timestamps, such as a usage message created at exactly the session's creation time, leave the affected session's usage unavailable. Imported records whose database timestamps follow message completion use the original message timestamp for daily attribution; these totals are marked approximate. Unsupported schemas, invalid records, unreadable databases or databases exceeding the reader's session or record limits also leave usage unavailable.

Before the first successful measurement, the pane shows **Usage unavailable** and details show **Unknown** instead of numeric zero. If a later read fails, the last successful totals remain visible as **Last collected** while collection retries.

OpenCode usage collection is local-only; SSH/Coder usage and OpenCode quota tracking are unsupported. The local history picker still uses Tether's default application environment; local launch-time session checks and new-session discovery use the effective launch environment. A session visible under a different launch environment may therefore be absent from the picker.

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
  password through encrypted stdin, once when the reader starts; policies
  requiring a TTY or a different sudo password leave usage unavailable without
  interrupting the terminal. If the reader exits, the next poll reconnects it.
- Collection begins when a transcript is available, often after the first
  prompt. The pane shows **Waiting for remote usage** until it is found. A Codex
  process that exits before discovery may have no collected usage. Ambiguous
  matches stay pending.
- Claude transcript discovery supports working directories containing dots,
  spaces or underscores. Remote collection also finds long project directory
  names by the saved conversation ID when exactly one transcript matches.
- If the host refuses the login or the **sudo** password, or a reader that was
  sent the password gives no ready response within 30 seconds, Tether tries
  once and sends nothing further, so a wrong password costs a single failed
  attempt. It does not try again until you edit that environment or open a
  session on it that connects; usage shows as unavailable until then. The
  usage and subagent readers start one at a time per environment, so they
  cannot both send the password before the first answer is known.
- Other connection or reader failures retry automatically. **Last collected** means
  the displayed totals may be stale; hover for details. History retains the last
  successfully collected totals after disconnection or exit.
- This collects conversations launched in Tether, not all historical sessions
  on the remote host, and subagent transcripts do not count toward a session's
  usage here. Opening a child-agent viewer is a separate transcript read; saved-ID conversation recovery is described in [Sessions](sessions.md#resume-conversation). Remote OpenCode usage is not yet supported.

## Per-Session Cost Strip

The pane footer shows available usage and its cost source: **API equivalent** for estimates, or **CLI reported** for native OpenCode and legacy Crush amounts. Click its details control to inspect the native conversation ID, working directory, environment, launch profile, tracking coverage and cost basis. Costs do not represent subscription invoices.

For Codex, details distinguish requested launch overrides from the latest observed model and reasoning effort. The last reported request size and context-window capacity are shown when available. This is a transcript observation, not a live measurement of remaining context. Missing metadata is labelled unavailable instead of being presented as a measured zero.

Optional lifecycle hooks add last-hook time, approvals, compaction counts and active subagent IDs. Counts cover events observed during the current Tether session. See [Codex settings](settings.md#codex).

## Global Usage Footer

The sidebar footer shows today's cost and a seven-day sparkline. Click it to open usage history. Tool and environment breakdowns describe attributed local and remote observations; unattributed backfill remains separate.

## Usage History Dialog

Filter by CLI, project, environment, model and UTC date range. Compare the selected period with the preceding period of the same length, inspect the daily trend and click a day to narrow the session ledger.

Filter checkboxes use the current theme's accent color and follow its light or dark appearance.

The sortable ledger expands into per-model input, output, cache and reasoning breakdowns. Model and date filters use the matching daily model usage rather than a conversation's entire lifetime. Unknown daily timing is included only in all-time views and is labelled; approximate snapshots remain distinguishable. No conversation text is displayed.

## Budget Guardrails

[Settings -> Usage](settings.md#usage) has optional **Daily budget warning (USD)** and **Weekly budget warning (USD)** thresholds. Blank or `0` disables a warning.

Daily warnings use the UTC calendar day; weekly warnings use Monday-Sunday UTC. When tracked usage crosses a threshold, Tether shows an in-app warning and turns the usage footer amber. The last-warning period is saved locally to avoid repeating a warning after restart. These warnings do not change provider limits.

## Export

[Settings -> Usage](settings.md#usage) provides **Export as CSV** and **Export as JSON**. CSV contains a row per session. JSON includes per-session and per-model totals, daily buckets, timing coverage, working directories and environment IDs. Both ask for a save location; exports contain usage metadata, not conversation text.

## Quota Tracking

Enable **Show usage quota in sidebar** (on by default) in [Settings -> Usage](settings.md#usage). The sidebar shows the percentage left and the next reported reset. Quota polling starts shortly after launch and refreshes every five minutes; click the footer to refresh.

Codex quota uses the installed Codex CLI's supported app-server interface. Tether shows reported quota buckets with their actual window durations and retains the last successful observation when a refresh fails. A last-known reading is labelled with its observation time. Availability depends on the installed CLI, sign-in and account mode.

OpenCode quota tracking is not supported, locally or remotely.

Set **Codex quota warning** in [Settings → CLI tools → Codex CLI](settings.md#codex) to a remaining-percentage threshold. `0` disables notifications. Fresh successful measurements at or below the threshold produce one in-app warning per reported window reset. Stale, failed, expired and unknown measurements do not trigger warnings. Subscription quota must be enabled.

## Codex Account Usage

[Settings → CLI tools → Codex CLI](settings.md#codex) has an explicit **Load account usage** action. It displays the account-wide token summary, daily trend, streaks, longest turn and quota windows that Codex reports. These figures have a different scope from Tether's local session estimates and are never added to them. Unsupported methods or unavailable account fields are labelled. Opening Settings alone does not request account usage.

## Privacy

Local transcript files and usage databases are read locally. For SSH and Coder sessions, prompts and
responses stay on the remote host: the usage reader sends only model names, reasoning
effort, token counts, context capacity, timestamps, and source/cursor metadata over the authenticated connection.
The [sidebar subagent list](sessions.md#subagents) adds two reads, made by a second reader process on the host that is separate from the usage reader (on an SSH host that uses **sudo**, a second sudo login per Tether run).
The list itself carries only metadata: each subagent's small meta file (type and
description), and from its transcript the record types, timestamps, model and effort,
token counts, message IDs, the IDs of nested-subagent calls, and the first 400
characters of any plain user message (normally just the task it was given).
Assistant text, tool inputs and tool results stay on the host. Only when you open a
subagent to read it does Tether fetch that one transcript's full lines (for a long one,
its start and its last 8 MB), into memory only. Nothing is saved or logged, and turning off **Show subagents in
sidebar** stops both reads.
Tether persists summaries and read positions, never conversation text or resolved
passwords. No usage data is uploaded to a third-party analytics service.

Its pricing table may refresh once a day from `raw.githubusercontent.com`. Optional quota refreshes contact providers; Codex requests use the installed CLI. Explicit account/configuration inspection may also contact provider services through Codex. Tether does not send prompts through these read-only requests or copy Codex credentials into its renderer, files or logs.

The configuration inspector exposes only selected settings, source categories, native profile names and integration names. Commands, URLs, environment values and authentication payloads are omitted. Exports include project paths and IDs, so choose their destination accordingly.
