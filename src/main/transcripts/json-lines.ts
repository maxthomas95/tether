/** Small helpers for reading the JSONL files the agent CLIs write. The formats are internal, so all of them tolerate junk. */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

/** One JSONL line as an object, or null for anything that is not one. */
export function parseLine(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try { return asRecord(JSON.parse(trimmed)); } catch { return null; }
}

/** A trimmed, length-capped string, or undefined when empty or not a string. */
export function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function validIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : value;
}

export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
