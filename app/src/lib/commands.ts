// Command palette matching (⌘K). Pure: the palette renders `matchCommands` and runs the chosen command's action.
export type Command = { id: string; title: string; group: string; keywords?: string };

/** Case-insensitive match: every query word must appear in title, group or keywords; title-prefix matches rank first. */
export function matchCommands<T extends Command>(all: readonly T[], query: string, limit = 12): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return all.slice(0, limit);
  const hay = (c: T) => `${c.title} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
  return all
    .filter((c) => words.every((w) => hay(c).includes(w)))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(words[0]!)) - Number(!b.title.toLowerCase().startsWith(words[0]!)))
    .slice(0, limit);
}
