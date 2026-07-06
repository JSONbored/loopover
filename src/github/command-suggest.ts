/** Pure did-you-mean suggester for unrecognized @gittensory verbs (#2170). */

export type CommandSuggestCatalog = {
  mentionCommands: readonly string[];
  actionCommands: readonly string[];
  actionAliases: Readonly<Record<string, string>>;
};

/** Max Levenshtein distance for a did-you-mean suggestion. */
export const COMMAND_SUGGEST_MAX_DISTANCE = 2;

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let row = 0; row < rows; row++) matrix[row]![0] = row;
  for (let col = 0; col < cols; col++) matrix[0]![col] = col;
  for (let row = 1; row < rows; row++) {
    for (let col = 1; col < cols; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row]![col] = Math.min(
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost,
      );
    }
  }
  return matrix[left.length]![right.length]!;
}

function commandSuggestTargets(catalog: CommandSuggestCatalog): string[] {
  return [...catalog.mentionCommands, ...catalog.actionCommands, ...Object.keys(catalog.actionAliases)];
}

export function isKnownGittensoryCommandVerb(rawVerb: string, catalog: CommandSuggestCatalog): boolean {
  const verb = rawVerb.trim().toLowerCase();
  if (!verb) return false;
  const canonical = catalog.actionAliases[verb] ?? verb;
  return (
    catalog.mentionCommands.includes(canonical) ||
    catalog.actionCommands.includes(canonical as (typeof catalog.actionCommands)[number])
  );
}

/** Return the closest catalog command within {@link COMMAND_SUGGEST_MAX_DISTANCE}, or null. */
export function suggestCommand(rawVerb: string, catalog: CommandSuggestCatalog): string | null {
  const verb = rawVerb.trim().toLowerCase();
  if (!verb || isKnownGittensoryCommandVerb(verb, catalog)) return null;
  const targets = commandSuggestTargets(catalog);
  let best: { name: string; distance: number } | null = null;
  for (const name of targets) {
    const distance = levenshteinDistance(verb, name);
    if (best === null || distance < best.distance) {
      best = { name, distance };
    }
  }
  if (!best || best.distance > COMMAND_SUGGEST_MAX_DISTANCE) return null;
  return best.name;
}

export function formatDidYouMeanLine(suggestion: string): string {
  return `- Did you mean \`@gittensory ${suggestion}\`?`;
}

/** Help-card prefix lines for an unrecognized verb, or empty when no close match exists. */
export function buildDidYouMeanSections(
  rawVerb: string | undefined,
  suggest: (verb: string) => string | null,
): string[] {
  if (!rawVerb) return [];
  const suggestion = suggest(rawVerb);
  return suggestion !== null ? [formatDidYouMeanLine(suggestion), ""] : [];
}
