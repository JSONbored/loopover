/** Pure did-you-mean suggester for unrecognized @gittensory verbs (#2170). */

export type CommandSuggestCatalog = {
  mentionCommands: readonly string[];
  actionCommands: readonly string[];
  actionAliases: Readonly<Record<string, string>>;
};

/** Max Levenshtein distance for a did-you-mean suggestion. */
export const COMMAND_SUGGEST_MAX_DISTANCE = 2;

/** Longest verb that can still be within the did-you-mean threshold of a catalog command. */
export const COMMAND_SUGGEST_MAX_VERB_LENGTH = 64;

function boundedLevenshteinDistance(
  left: string,
  right: string,
  maxDistance: number,
): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance)
    return maxDistance + 1;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, col) => col);
  let current = Array<number>(right.length + 1).fill(0);

  for (let row = 1; row <= left.length; row++) {
    current[0] = row;
    let rowMin = current[0]!;
    for (let col = 1; col <= right.length; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      const distance = Math.min(
        previous[col]! + 1,
        current[col - 1]! + 1,
        previous[col - 1]! + cost,
      );
      current[col] = distance;
      rowMin = Math.min(rowMin, distance);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

export function levenshteinDistance(left: string, right: string): number {
  return boundedLevenshteinDistance(left, right, Number.MAX_SAFE_INTEGER);
}

function commandSuggestTargets(catalog: CommandSuggestCatalog): string[] {
  return [
    ...catalog.mentionCommands,
    ...catalog.actionCommands,
    ...Object.keys(catalog.actionAliases),
  ];
}

export function isKnownGittensoryCommandVerb(
  rawVerb: string,
  catalog: CommandSuggestCatalog,
): boolean {
  const verb = rawVerb.trim().toLowerCase();
  if (!verb) return false;
  const canonical = catalog.actionAliases[verb] ?? verb;
  return (
    catalog.mentionCommands.includes(canonical) ||
    catalog.actionCommands.includes(canonical)
  );
}

/** Return the closest catalog command within {@link COMMAND_SUGGEST_MAX_DISTANCE}, or null. */
export function suggestCommand(
  rawVerb: string,
  catalog: CommandSuggestCatalog,
): string | null {
  const verb = rawVerb.trim().toLowerCase();
  if (
    !verb ||
    verb.length > COMMAND_SUGGEST_MAX_VERB_LENGTH ||
    isKnownGittensoryCommandVerb(verb, catalog)
  )
    return null;
  const targets = commandSuggestTargets(catalog);
  let best: { name: string; distance: number } | null = null;
  for (const name of targets) {
    if (Math.abs(verb.length - name.length) > COMMAND_SUGGEST_MAX_DISTANCE)
      continue;
    const distance = boundedLevenshteinDistance(
      verb,
      name,
      COMMAND_SUGGEST_MAX_DISTANCE,
    );
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
