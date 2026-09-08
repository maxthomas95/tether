/** Trim repeated single-character suffixes in linear time, without regex retries. */
export function trimTrailingCharacter(value: string, character: string): string {
  let end = value.length;
  while (end > 0 && value.at(end - 1) === character) end--;
  return value.slice(0, end);
}

/** Trim the edges only; repeated characters inside the value are preserved. */
export function trimBoundaryCharacter(value: string, character: string): string {
  let start = 0;
  while (start < value.length && value[start] === character) start++;
  return trimTrailingCharacter(value.slice(start), character);
}
