/**
 * Fuzzy matcher for the Ctrl+P session quick switcher.
 *
 * Pure, dependency-free, and deliberately regex-free: the query comes straight
 * from a user-controlled input, so building a `RegExp` from it would risk both
 * ReDoS (Sonar S5852) and metacharacter injection. All matching is a
 * left-to-right character walk over the candidate string.
 *
 * Scoring favours, in order: a match at all, matches in higher-weight fields
 * (label > working dir > environment name > CLI tool id), contiguous runs over
 * scattered hits, matches anchored at the start of the field or at a word
 * boundary, and shorter candidates (a query that fills more of a field beats
 * one buried in a long string). All comparisons are case-insensitive.
 */

/** A field of a session that the query can match against, with its weight. */
export interface SearchField {
  /** The raw text to match (already the human-facing value, e.g. label). */
  text: string;
  /** Relative importance — higher means a hit here scores more. */
  weight: number;
}

/** Per-field weights. Label hits beat dir hits beat env/CLI hits. */
export const FIELD_WEIGHTS = {
  label: 1.0,
  dir: 0.6,
  env: 0.45,
  cli: 0.4,
} as const;

/**
 * Result of scoring a single field against a query: the score plus the matched
 * character index ranges (for optional highlight rendering). Ranges are in the
 * coordinate space of the original (non-lowercased) field text.
 */
interface FieldMatch {
  score: number;
  ranges: Array<[number, number]>;
}

/** True for characters that begin a new "word" for word-boundary bonuses. */
function isWordBoundary(prevChar: string | undefined): boolean {
  if (prevChar === undefined) return true; // start of string
  return prevChar === ' ' || prevChar === '/' || prevChar === '\\'
    || prevChar === '-' || prevChar === '_' || prevChar === '.';
}

/**
 * Subsequence-match `query` against `text` (both already lowercased by the
 * caller) and return a score with matched ranges, or `null` if `query` is not
 * a subsequence of `text`.
 *
 * Greedy left-to-right walk: each query char advances past the first matching
 * text char. This is O(text length) and never backtracks — no regex, no
 * catastrophic-backtracking surface.
 */
function scoreField(query: string, lowerText: string): FieldMatch | null {
  if (query.length === 0) return { score: 0, ranges: [] };
  if (lowerText.length === 0) return null;

  const ranges: Array<[number, number]> = [];
  let qi = 0;
  let runStart = -1;
  let prevMatchIdx = -2;
  let bonus = 0;

  for (let ti = 0; ti < lowerText.length && qi < query.length; ti++) {
    if (lowerText[ti] !== query[qi]) continue;

    // Contiguity: a char that immediately follows the previous match extends
    // the current run; otherwise start a new run.
    if (ti === prevMatchIdx + 1) {
      bonus += 3; // contiguous chars are cheap to read — reward streaks
      ranges[ranges.length - 1][1] = ti + 1;
    } else {
      runStart = ti;
      ranges.push([runStart, ti + 1]);
    }

    // Word-boundary / start anchoring bonus.
    if (isWordBoundary(ti > 0 ? lowerText[ti - 1] : undefined)) {
      bonus += ti === 0 ? 5 : 2;
    }

    prevMatchIdx = ti;
    qi++;
  }

  if (qi < query.length) return null; // not a subsequence

  // Base: matching at all is worth a fixed amount; density (query length over
  // text length) rewards filling more of a shorter field over hiding in a long
  // one. Add the accumulated contiguity / boundary bonus.
  const density = query.length / lowerText.length;
  const score = 10 + bonus + density * 10;
  return { score, ranges };
}

/** A single field's contribution to a candidate's overall match. */
export interface MatchedField {
  /** Which input field this came from (for highlight mapping by the caller). */
  key: string;
  /** Matched character ranges within that field's text. */
  ranges: Array<[number, number]>;
}

/** Outcome of matching a query against one candidate's fields. */
export interface MatchResult {
  matched: boolean;
  /** Combined, weighted score across all fields. Higher is better. */
  score: number;
  /** Per-field matched ranges, only for fields that actually matched. */
  fields: MatchedField[];
}

/** A named, weighted field belonging to a candidate. */
export interface NamedSearchField extends SearchField {
  /** Stable key identifying the field (e.g. 'label', 'dir'). */
  key: string;
}

/**
 * Match `query` against a candidate's set of named fields. The candidate
 * matches when the query is a subsequence of AT LEAST ONE field. The overall
 * score is the best single-field weighted score plus a small fraction of the
 * other matching fields, so a hit in a high-weight field dominates but extra
 * corroborating hits still nudge a tie.
 */
export function matchFields(query: string, fields: NamedSearchField[]): MatchResult {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    // Empty query: everything matches with a neutral score (caller decides
    // ordering, typically the natural sidebar order).
    return { matched: true, score: 0, fields: [] };
  }

  let best = 0;
  let rest = 0;
  const matchedFields: MatchedField[] = [];

  for (const field of fields) {
    const fm = scoreField(trimmed, field.text.toLowerCase());
    if (!fm) continue;
    const weighted = fm.score * field.weight;
    if (weighted > best) {
      rest += best * 0.15; // demote the previous best into the corroboration pool
      best = weighted;
    } else {
      rest += weighted * 0.15;
    }
    matchedFields.push({ key: field.key, ranges: fm.ranges });
  }

  if (matchedFields.length === 0) {
    return { matched: false, score: 0, fields: [] };
  }
  return { matched: true, score: best + rest, fields: matchedFields };
}

/** A candidate session reduced to the fields the switcher searches. */
export interface SearchableSession {
  id: string;
  label: string;
  workingDir: string;
  environmentName: string;
  cliToolId: string;
}

/** A ranked search hit: the original candidate plus its match metadata. */
export interface SearchHit<T extends SearchableSession> {
  session: T;
  score: number;
  fields: MatchedField[];
}

/**
 * Rank `sessions` against `query`, returning only matches, best first. With an
 * empty query the original order is preserved (stable). The sort is stable on
 * ties via the candidates' original index so results don't jitter as the user
 * types.
 */
export function searchSessions<T extends SearchableSession>(
  query: string,
  sessions: T[],
): Array<SearchHit<T>> {
  const hits: Array<{ hit: SearchHit<T>; index: number }> = [];

  sessions.forEach((session, index) => {
    const result = matchFields(query, [
      { key: 'label', text: session.label, weight: FIELD_WEIGHTS.label },
      { key: 'dir', text: session.workingDir, weight: FIELD_WEIGHTS.dir },
      { key: 'env', text: session.environmentName, weight: FIELD_WEIGHTS.env },
      { key: 'cli', text: session.cliToolId, weight: FIELD_WEIGHTS.cli },
    ]);
    if (!result.matched) return;
    hits.push({
      hit: { session, score: result.score, fields: result.fields },
      index,
    });
  });

  hits.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    return a.index - b.index; // stable on ties
  });

  return hits.map(h => h.hit);
}
