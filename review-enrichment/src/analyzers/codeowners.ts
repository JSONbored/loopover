// CODEOWNERS + blast-radius analyzer (#1515). Fetches .github/CODEOWNERS (with fallbacks to CODEOWNERS and
// docs/CODEOWNERS), matches each changed file against the glob rules using last-match-wins semantics (per GitHub),
// and reports files where the PR author is absent from the owner list — plus the blast radius derived at render
// time from the unique set of ownership domains (users/teams) crossed by the PR.
// CODEOWNERS matching uses a bounded, linear glob matcher instead of repository-controlled regular expressions.
// Fail-safe: returns [] on any network error, non-ok response, or missing/unreadable CODEOWNERS file.
import type { EnrichRequest, CodeownersFinding } from "../types.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // rejects `..` and other path-traversal segments
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;
const MAX_FILES_REPORTED = 20;

type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "star" }
  | { kind: "question" }
  | { kind: "globstar" };

interface ParsedRule {
  tokens: GlobToken[];
  anchored: boolean;
  owners: string[];
}

const MAX_CODEOWNERS_BYTES = 64 * 1024;
const MAX_CODEOWNERS_RULES = 1000;
const MAX_CODEOWNERS_PATTERN_LENGTH = 512;

// ── Glob matching ─────────────────────────────────────────────────────────────

/** Normalize a CODEOWNERS pattern and determine whether GitHub treats it as root-anchored. */
function normalizePattern(pattern: string): {
  pattern: string;
  anchored: boolean;
} {
  let p = pattern;

  const leadingSlash = p.startsWith("/");
  if (leadingSlash) p = p.slice(1);

  // Trailing `/` means "all files under this directory" — expand to `<dir>/**`.
  if (p.endsWith("/")) p += "**";

  // Anchored when explicitly rooted, or when a path separator appears outside a leading `**/`.
  return {
    pattern: p,
    anchored: leadingSlash || (p.includes("/") && !p.startsWith("**/")),
  };
}

function compilePattern(pattern: string): { tokens: GlobToken[]; anchored: boolean } {
  const { pattern: p, anchored } = normalizePattern(pattern);
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*" && i + 1 < p.length && p[i + 1] === "*") {
      i += 2;
      if (p[i] === "/") i++; // consume the `/` that follows `**`
      if (tokens.at(-1)?.kind !== "globstar") tokens.push({ kind: "globstar" });
    } else if (c === "*") {
      i++;
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (c === "?") {
      tokens.push({ kind: "question" });
      i++;
    } else {
      tokens.push({ kind: "literal", value: c });
      i++;
    }
  }
  return { tokens, anchored };
}

function matchTokens(tokens: GlobToken[], filePath: string, start = 0): boolean {
  let states = new Set<number>([start]);
  for (const token of tokens) {
    const next = new Set<number>();
    for (const pos of states) {
      if (token.kind === "literal") {
        if (filePath[pos] === token.value) next.add(pos + 1);
      } else if (token.kind === "question") {
        if (pos < filePath.length && filePath[pos] !== "/") next.add(pos + 1);
      } else if (token.kind === "star") {
        next.add(pos);
        for (let j = pos; j < filePath.length && filePath[j] !== "/"; j++) {
          next.add(j + 1);
        }
      } else {
        for (let j = pos; j <= filePath.length; j++) next.add(j);
      }
    }
    if (next.size === 0) return false;
    states = next;
  }
  return states.has(filePath.length);
}

function matchesRule(rule: ParsedRule, filePath: string): boolean {
  if (rule.anchored) return matchTokens(rule.tokens, filePath);
  if (matchTokens(rule.tokens, filePath)) return true;
  for (let i = 0; i < filePath.length; i++) {
    if (filePath[i] === "/" && matchTokens(rule.tokens, filePath, i + 1)) {
      return true;
    }
  }
  return false;
}

/** Convert a CODEOWNERS glob pattern to a RegExp that matches repo-root-relative file paths.
 *  Kept for compatibility with callers that only need a display/debug regex; matching uses the
 *  linear token matcher above so repository-controlled glob input cannot trigger regex backtracking. */
export function patternToRegex(pattern: string): RegExp {
  const { pattern: p, anchored } = normalizePattern(pattern);
  let re = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*" && i + 1 < p.length && p[i + 1] === "*") {
      i += 2;
      if (p[i] === "/") i++;
      if (!re.endsWith(".*")) re += ".*";
    } else if (c === "*") {
      i++;
      if (!re.endsWith("[^/]*")) re += "[^/]*";
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
  const boundedContent = content.slice(0, MAX_CODEOWNERS_BYTES);
  for (const rawLine of boundedContent.split("\n")) {
    if (rules.length >= MAX_CODEOWNERS_RULES) break;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern || pattern.length > MAX_CODEOWNERS_PATTERN_LENGTH) continue;
    // Accept @handle and @org/team; also plain email (contains `@` but no leading `@`).
    const owners = parts
      .slice(1)
      .filter((o) => o.startsWith("@") || (o.includes("@") && !o.startsWith("#")));
    if (owners.length === 0) continue; // no owners → unowned pattern, skip
    try {
      rules.push({ ...compilePattern(pattern), owners });
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
    if (matchesRule(rule, filePath)) owners = rule.owners;
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
