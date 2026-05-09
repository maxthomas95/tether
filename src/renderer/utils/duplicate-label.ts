const COPY_SUFFIX_RE = /\s?\(copy(?:\s\d{1,9})?\)$/;

export function stripCopySuffix(label: string): string {
  return label.replace(COPY_SUFFIX_RE, '').trimEnd();
}

export function nextDuplicateLabel(sourceLabel: string, existingLabels: Iterable<string>): string {
  const base = stripCopySuffix(sourceLabel) || sourceLabel;
  const taken = new Set(existingLabels);
  const first = `${base} (copy)`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${base} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
