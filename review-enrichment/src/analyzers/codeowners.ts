// CODEOWNERS + blast-radius analyzer (#1515). Fetches .github/CODEOWNERS (with fallbacks to CODEOWNERS and
// docs/CODEOWNERS), matches each changed file against the glob rules using last-match-wins semantics (per GitHub),
// and reports files where the PR author is absent from the owner list — plus the blast radius derived at render
// time from the unique set of ownership domains (users/teams) crossed by the PR.
// Glob-to-regex conversion uses only atomic `[^/]*`, `.*`, and literal escapes — no catastrophic backtracking.
// Fail-safe: returns [] on any network error, non-ok response, or missing/unreadable CODEOWNERS file.
import type { EnrichRequest, CodeownersFinding } from "../types.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // rejects `..` and other path-traversal segments
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;
const MAX_FILES_REPORTED = 20;

interface ParsedRule {
  regex: RegExp;
  owners: string[];
}

// ── Glob matching ─────────────────────────────────────────────────────────────

/** Convert a CODEOWNERS glob pattern to a RegExp that matches repo-root-relative file paths.
 *  `*` matches any non-`/` characters; `**` matches across separators; `?` matches one non-`/` char.
 *  A leading `/` or interior `/` anchors the pattern to the repo root; a leading glob does not. */
export function patternToRegex(pattern: string): RegExp {
  let p = pattern;

  const leadingSlash = p.startsWith("/");
  if (leadingSlash) p = p.slice(1);

  // Trailing `/` means "all files under this directory" — expand to `<dir>/**`.
  if (p.endsWith("/")) p += "**";

  // Anchored when explicitly rooted, or when a path separator appears outside a leading `**/`.
  const anchored = leadingSlash || (p.includes("/") && !p.startsWith("**/"));

  let re = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*" && i + 1 < p.length && p[i + 1] === "*") {
      i += 2;
      if (p[i] === "/") i++; // consume the `/` that follows `**`
      re += ".*";
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += c.replace(/[.+^()|\{\}\[\]\\$]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`);
}

// ── CODEOWNERS parser ─────────────────────────────────────────────────────────

/** Parse CODEOWNERS text into ordered rules. Lines are returned in source order; last match wins at query time. */
export function parseCodeowners(content: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;
    // Accept @handle and @org/team; also plain email (contains `@` but no leading `@`).
    const owners = parts
      .slice(1)
      .filter((o) => o.startsWith("@") || (o.includes("@") && !o.startsWith("#")));
    if (owners.length === 0) continue; // no owners → unowned pattern, skip
    try {
      rules.push({ regex: patternToRegex(pattern), owners });
    } catch {
      // malformed pattern — skip
    }
  }
  return rules;
}

/** Find the owners for a repo-root-relative file path. Last matching rule wins (CODEOWNERS semantics). */
export function findOwners(rules: ParsedRule[], filePath: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (rule.regex.test(filePath)) owners = rule.owners;
  }
  return owners;
}

/** True when the PR author (GitHub login) appears in the CODEOWNERS owner list, normalising the leading `@`. */
export function authorMatchesOwner(author: string, owners: string[]): boolean {
  const norm = author.startsWith("@")
    ? author.toLowerCase()
    : `@${author.toLowerCase()}`;
  return owners.some((o) => o.toLowerCase() === norm);
}

// ── Network ───────────────────────────────────────────────────────────────────

/** Try each CODEOWNERS location in priority order; return raw content of the first found, or null. */
async function fetchCodeowners(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const resp = await fetchFn(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
        { headers, signal },
      );
      if (!resp.ok) continue;
      return await resp.text();
    } catch {
      // network error or already-aborted signal → try next location
    }
  }
  return null;
}

// ── Analyzer entrypoint ───────────────────────────────────────────────────────

/** Report changed files whose CODEOWNERS rule does not include the PR author, and surface blast-radius context. */
export async function scanCodeowners(
  req: EnrichRequest,
  fetchFn: typeof fetch,
  opts?: { signal?: AbortSignal },
): Promise<CodeownersFinding[]> {
  const { repoFullName, githubToken, author, files = [] } = req;
  if (!githubToken || !author) return [];

  const parts = repoFullName.split("/");
  const repoOwner = parts[0];
  const repoName = parts[1];
  if (
    !repoOwner ||
    !repoName ||
    !SLUG_RE.test(repoOwner) ||
    !SLUG_RE.test(repoName)
  )
    return [];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const content = await fetchCodeowners(
    repoOwner,
    repoName,
    headers,
    fetchFn,
    opts?.signal,
  );
  if (!content) return [];

  const rules = parseCodeowners(content);
  if (rules.length === 0) return [];

  const findings: CodeownersFinding[] = [];
  for (const file of files) {
    if (findings.length >= MAX_FILES_REPORTED) break;
    const owners = findOwners(rules, file.path);
    if (owners.length === 0) continue; // unowned file — not a violation
    if (authorMatchesOwner(author, owners)) continue; // author is listed — no violation
    findings.push({ file: file.path, owners });
  }

  return findings;
}
