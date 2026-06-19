/**
 * Reviewer-routing signal (#540/#830): parse CODEOWNERS and rank reviewer suggestions for
 * a pull request's changed files. Only user logins are returned — team entries (@org/team)
 * are skipped at parse time because the GitHub request-reviewers API requires separate team
 * handling and the issue spec says to skip teams.
 */

/** A single ranked reviewer suggestion produced by buildReviewerRouting. */
export type ReviewerSuggestion = {
  /** GitHub login (without leading @). */
  login: string;
  /** Number of changed files this reviewer owns. Higher = more relevant. */
  fileCount: number;
};

/** Result of buildReviewerRouting — null when CODEOWNERS is absent or has no user entries. */
export type ReviewerRoutingResult = {
  suggestions: ReviewerSuggestion[];
};

/**
 * Parse a raw CODEOWNERS file into (pattern → logins[]) pairs. Team entries (@org/team)
 * are excluded because they cannot be passed directly to the request-reviewers users array.
 * Later rules take precedence over earlier ones (same semantics as .gitignore / GitHub itself).
 */
export function parseCodeowners(content: string): Array<{ pattern: string; logins: string[] }> {
  const rules: Array<{ pattern: string; logins: string[] }> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;
    const logins: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      if (!entry.startsWith("@")) continue;
      const name = entry.slice(1);
      // Skip team entries: @org/team contains a slash.
      if (name.includes("/")) continue;
      if (name) logins.push(name.toLowerCase());
    }
    if (logins.length > 0) rules.push({ pattern, logins });
  }
  return rules;
}

/**
 * Match a file path against a CODEOWNERS pattern. Implements the GitHub CODEOWNERS glob
 * semantics used in practice:
 * - A pattern without a leading `/` matches anywhere in the tree.
 * - A pattern with a leading `/` is anchored to the repo root.
 * - A pattern ending with `/` matches all files under that directory.
 * - `*` matches any string within a path segment (not `/`).
 * - `**` matches any number of path segments (including zero).
 */
function matchesCodeownersPattern(pattern: string, filePath: string): boolean {
  // Normalise: drop leading slash for matching (we treat all paths as root-relative).
  const anchored = pattern.startsWith("/");
  const normalised = anchored ? pattern.slice(1) : pattern;

  // Directory shorthand: `docs/` matches anything under `docs/`.
  const dirMatch = normalised.endsWith("/");
  const effectivePattern = dirMatch ? normalised.slice(0, -1) : normalised;

  // Build a regex from the glob.
  const regexBody = effectivePattern
    .split("**")
    .map((seg) =>
      seg
        .split("*")
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");

  let regex: RegExp;
  if (anchored) {
    // Anchored: must match from the start.
    if (dirMatch) {
      regex = new RegExp(`^${regexBody}(/|$)`);
    } else {
      regex = new RegExp(`^${regexBody}(/.*)?$`);
    }
  } else {
    // Unanchored: the pattern can match any segment boundary.
    if (dirMatch) {
      regex = new RegExp(`(^|/)${regexBody}(/|$)`);
    } else {
      regex = new RegExp(`(^|/)${regexBody}(/.*)?$`);
    }
  }

  return regex.test(filePath);
}

/**
 * Rank CODEOWNERS-derived reviewer suggestions for a set of changed files.
 *
 * Algorithm:
 * 1. For each changed file, find the LAST matching CODEOWNERS rule (GitHub semantics).
 * 2. Tally how many files each owner covers.
 * 3. Return owners sorted descending by file count, deduped and normalised to lowercase.
 *
 * The caller is responsible for:
 * - Filtering out the PR author.
 * - Filtering out already-requested reviewers (idempotency).
 */
export function buildReviewerRouting(changedFilePaths: string[], codeownersContent: string): ReviewerRoutingResult {
  const rules = parseCodeowners(codeownersContent);
  if (rules.length === 0) return { suggestions: [] };

  const tally = new Map<string, number>();

  for (const filePath of changedFilePaths) {
    // GitHub: the LAST matching rule wins.
    let matchedLogins: string[] | null = null;
    for (const rule of rules) {
      if (matchesCodeownersPattern(rule.pattern, filePath)) {
        matchedLogins = rule.logins;
      }
    }
    if (!matchedLogins) continue;
    for (const login of matchedLogins) {
      tally.set(login, (tally.get(login) ?? 0) + 1);
    }
  }

  const suggestions: ReviewerSuggestion[] = Array.from(tally.entries())
    .map(([login, fileCount]) => ({ login, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.login.localeCompare(b.login));

  return { suggestions };
}
