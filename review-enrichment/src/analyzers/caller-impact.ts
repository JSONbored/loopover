// Cross-file caller-impact / dead-symbol analyzer (#1509). Surfaces two cross-file hazards the no-checkout
// `claude --print` reviewer (which only sees the diff) is blind to:
//   1. An exported top-level symbol the PR removes / renames / changes the signature of that STILL has live callers
//      in files the PR did NOT touch — a hidden compile/runtime break. Callers are resolved on the repo's default
//      branch via the GitHub Code Search API, which is exactly where the pre-existing (about-to-break) callers live.
//   2. A newly-exported symbol referenced nowhere in the PR — dead-on-arrival. Code Search indexes the DEFAULT
//      branch only, so a brand-new symbol is invisible to it; this case is therefore judged from the diff (the new
//      export is dead if no added line outside its own declaration references it), and entrypoint files (index.*,
//      *.d.ts) are skipped because public API is intentionally unused internally.
//
// Reports symbol names + unchanged caller file paths only — never source. Uses the request's short-lived githubToken
// for Code Search; fail-safe: returns [] without a token, and a failed/rate-limited search drops that symbol only.
import type { EnrichRequest, CallerImpactFinding } from "../types.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_SYMBOLS_SEARCHED = 8; // Code Search is rate-limited (~10/min); bound the per-PR symbol fan-out
const MAX_DEAD_REPORTED = 10; // cap dead-on-arrival findings (diff-only, no network)
const MAX_CALLER_FILES = 10; // cap caller files listed per symbol
const CODE_SEARCH_PER_PAGE = 20;

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENTRYPOINT_RE = /(^|\/)index\.[cm]?[jt]sx?$|\.d\.ts$/; // public-API files: skip dead-on-arrival here

interface ScanOptions {
  signal?: AbortSignal;
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments (no traversal / extra slashes) so a
 *  hostile `repoFullName` cannot redirect the token-bearing request elsewhere. Returns null when unsafe. */
export function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exported top-level identifier(s) declared on a single source line. Handles `export function|class|const|let|var|
 *  interface|type|enum|namespace NAME`, `export default function|class NAME`, and `export { a, b as c }` (the public
 *  name is the alias after `as`). Returns [] for `export * from …`, anonymous default exports, and non-export lines. */
export function parseExportedNames(line: string): string[] {
  const s = line.trim();
  if (!s.startsWith("export")) return [];

  const brace = s.match(/^export\s+(?:type\s+)?\{([^}]*)\}/);
  if (brace) {
    return brace[1]!
      .split(",")
      .map((part) => {
        const seg = part.trim();
        const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        if (asMatch) return asMatch[1]!;
        const id = seg.match(/^([A-Za-z_$][\w$]*)/);
        return id ? id[1]! : "";
      })
      .filter((name): name is string => name.length > 0 && name !== "default");
  }

  const def = s.match(
    /^export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
  );
  if (def) return [def[1]!];

  const decl = s.match(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  );
  if (decl) return [decl[1]!];

  return [];
}

/** Added ('+') and removed ('-') source lines of a unified-diff patch (markers stripped, hunk headers excluded). */
function splitPatch(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
  }
  return { added, removed };
}

interface DiffExports {
  /** name → normalized removed export-declaration text */
  removed: Map<string, string>;
  /** name → normalized added export-declaration text */
  added: Map<string, string>;
  /** every added source line across the PR (for the dead-on-arrival reference scan) */
  addedLines: string[];
  /** newly-exported name → the file it was added in (first seen) */
  addedExportFile: Map<string, string>;
}

const norm = (line: string): string => line.trim().replace(/\s+/g, " ");

/** Collect the PR's exported-symbol churn from every file patch. */
export function collectDiffExports(files: NonNullable<EnrichRequest["files"]>): DiffExports {
  const removed = new Map<string, string>();
  const added = new Map<string, string>();
  const addedLines: string[] = [];
  const addedExportFile = new Map<string, string>();

  for (const file of files) {
    if (!file.patch) continue;
    const { added: addedSrc, removed: removedSrc } = splitPatch(file.patch);
    for (const src of removedSrc) {
      for (const name of parseExportedNames(src)) removed.set(name, norm(src));
    }
    for (const src of addedSrc) {
      addedLines.push(src);
      for (const name of parseExportedNames(src)) {
        added.set(name, norm(src));
        if (!addedExportFile.has(name)) addedExportFile.set(name, file.path);
      }
    }
  }
  return { removed, added, addedLines, addedExportFile };
}

/** True when the symbol is used in an added line OTHER than its own export declaration (so it is NOT dead). The
 *  boundaries exclude identifier characters (incl. `$`) so a name is matched whole, never as a substring. */
export function isReferencedInDiff(symbol: string, addedLines: string[]): boolean {
  const re = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
  for (const line of addedLines) {
    if (!re.test(line)) continue;
    if (parseExportedNames(line).includes(symbol)) continue; // the export declaration itself
    return true;
  }
  return false;
}

/** Unchanged files (outside `changed`) that reference `symbol` on the default branch, or null on error/non-OK. */
async function searchExternalCallers(
  symbol: string,
  owner: string,
  repo: string,
  changed: Set<string>,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string[] | null> {
  try {
    const query = `"${symbol}" repo:${owner}/${repo}`;
    const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(query)}&per_page=${CODE_SEARCH_PER_PAGE}`;
    const res = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: Array<{ path?: string }> };
    const files = new Set<string>();
    for (const item of json.items ?? []) {
      if (typeof item.path === "string" && !changed.has(item.path)) {
        files.add(item.path);
      }
    }
    return [...files].slice(0, MAX_CALLER_FILES);
  } catch {
    return null;
  }
}

/** Analyzer entrypoint. Flags removed/renamed/changed exports that still have external callers, plus dead-on-arrival
 *  new exports. Fail-safe: returns [] without a token or changed exports; a failed search drops that symbol only. */
export async function scanCallerImpact(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CallerImpactFinding[]> {
  const token = req.githubToken;
  const repo = parseRepo(req.repoFullName);
  const files = req.files ?? [];
  if (!token || !repo || files.length === 0) return [];

  const { removed, added, addedLines, addedExportFile } = collectDiffExports(files);
  if (removed.size === 0 && added.size === 0) return [];

  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath) changed.add(file.previousPath);
  }

  const findings: CallerImpactFinding[] = [];

  // Removed / renamed / signature-changed exports → look for callers in unchanged files (bounded Code Search budget).
  let searched = 0;
  for (const [symbol, removedText] of removed) {
    if (searched >= MAX_SYMBOLS_SEARCHED) break;
    const addedText = added.get(symbol);
    // Present on both sides with an IDENTICAL declaration ⇒ moved/reformatted, not a real change ⇒ skip.
    if (addedText !== undefined && addedText === removedText) continue;
    searched++;
    const callerFiles = await searchExternalCallers(symbol, repo.owner, repo.repo, changed, token, fetchImpl, options.signal);
    if (!callerFiles || callerFiles.length === 0) continue;
    findings.push({
      symbol,
      kind: addedText === undefined ? "removed-with-callers" : "changed-with-callers",
      callerFiles: callerFiles.sort(),
    });
  }

  // Dead-on-arrival: newly-exported symbols (not also removed) referenced nowhere in the diff. Diff-only — Code
  // Search can't see a brand-new symbol. Skip public-entrypoint files, whose exports are meant for external use.
  let deadReported = 0;
  for (const [symbol] of added) {
    if (deadReported >= MAX_DEAD_REPORTED) break;
    if (removed.has(symbol)) continue; // changed, not new — handled above
    const file = addedExportFile.get(symbol) ?? "";
    if (ENTRYPOINT_RE.test(file)) continue; // likely public API
    if (isReferencedInDiff(symbol, addedLines)) continue;
    deadReported++;
    findings.push({ symbol, kind: "dead-on-arrival", callerFiles: [] });
  }

  return findings;
}
