export function tokenizeCliArgEntries(args: string[] = []): string[] {
  return args.flatMap((arg) => {
    const trimmed = arg.trim();
    if (!trimmed) return [];
    if (/^[^\s=]+=/.test(trimmed)) return [trimmed];
    return trimmed.split(/\s+/).filter(Boolean);
  });
}
