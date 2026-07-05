// Revert-recurrence analyzer (#1514, part of #1499). For the files a PR changes, reads each file's recent commit
// history from the GitHub API, finds the revert commits in it, fetches each revert commit's patch, and flags the
// file when the PR RE-INTRODUCES added lines in a region that revert previously REMOVED — a signal the change may
// be re-treading a known-bad path that was already reverted/hot-fixed out. This is heavy/external/historical
// analysis the no-checkout `claude --print` reviewer cannot do. Surfaces only the file, a re-introduced line, and
// a short revert-commit SHA prefix (plus the reverted PR number when the revert names one) — never file contents.
// Distinct from the churn-hotspot analyzer (#1513, defect DENSITY of the area) and the history analyzer (#1478,
// the AUTHOR's track record); this intersects the PR's added lines with a specific past revert's removed lines.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  RevertRecurrenceFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { isHistoryUninformativePath } from "./history-path.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILES_PROBED = 5; // bound the per-file commit-history fan-out, matching the other history-class analyzers
const COMMITS_PER_FILE = 15; // recent commits to inspect per probed file when looking for a revert
const MAX_REVERT_LOOKUPS = 10; // global cap on revert-commit detail fetches across all probed files
const MAX_FINDINGS = 25;
// GitHub's auto-generated revert commit has a `Revert "<original> (#N)"` subject; a hand-written revert body
// carries the `This reverts commit <sha>` trailer. Either shape confirms a revert without diff-classifying a patch.
const REVERT_SUBJECT_RE = /^revert\b/i;
const REVERT_BODY_RE = /this reverts commit [0-9a-f]{7,40}/i;
const REVERT_PR_RE = /\brevert\s+"[^"]*\(#(\d+)\)"/i;

/** An inclusive 1-based line range within a file. */
export interface Range {
  start: number;
  end: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub commit-list item this analyzer reads. */
interface CommitListItem {
  sha?: string;
  commit?: { message?: string };
}

/** The slice of a GitHub single-commit response this analyzer reads. */
interface CommitDetail {
  files?: Array<{ filename?: string; patch?: string }>;
}

/** True when a commit message describes a revert — a `Revert "…"` subject or a `This reverts commit <sha>` body. Pure. */
export function isRevertCommit(message: string): boolean {
  if (!message) return false;
  const subject = message.split("\n", 1)[0]?.trim() ?? "";
  return REVERT_SUBJECT_RE.test(subject) || REVERT_BODY_RE.test(message);
}

/** The PR number a revert undid, from GitHub's `Revert "<title> (#N)"` subject shape; undefined otherwise. Pure. */
export function revertedPrNumber(message: string): number | undefined {
  const match = REVERT_PR_RE.exec(message ?? "");
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Contiguous line-ranges on one side of a unified-diff patch: `"+"` = added new-file lines, `"-"` = removed
 *  old-file lines. Operates on GitHub's per-file `patch` (which has no `+++`/`---` file headers). Pure — returns
 *  [] for an empty patch or one with no valid hunk header. */
export function diffLineRanges(patch: string, side: "+" | "-"): Range[] {
  const ranges: Range[] = [];
  if (!patch) return ranges;
  let oldLine = 0;
  let newLine = 0;
  let active = false;
  let runStart = 0;
  let runEnd = 0;
  let inRun = false;
  const flush = (): void => {
    if (inRun) {
      ranges.push({ start: runStart, end: runEnd });
      inRun = false;
    }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!header) {
        active = false;
        continue;
      }
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      active = true;
      continue;
    }
    if (!active) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    if (marker === "+") {
      if (side === "+") {
        if (!inRun) {
          inRun = true;
          runStart = newLine;
        }
        runEnd = newLine;
      } else {
        flush();
      }
      newLine += 1;
    } else if (marker === "-") {
      if (side === "-") {
        if (!inRun) {
          inRun = true;
          runStart = oldLine;
        }
        runEnd = oldLine;
      } else {
        flush();
      }
      oldLine += 1;
    } else {
      flush();
      oldLine += 1;
      newLine += 1;
    }
  }
  flush();
  return ranges;
}

/** True when two inclusive integer ranges overlap. Pure. */
export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** The first `left` range that overlaps any `right` range, or null when none do. Pure. */
export function firstOverlap(left: Range[], right: Range[]): Range | null {
  for (const a of left) {
    for (const b of right) {
      if (rangesOverlap(a, b)) return a;
    }
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Fetch + parse JSON with the shared bounded-fetch guard rails. Returns the parsed body, or null on any
 *  error / non-200 so the caller degrades that one lookup rather than throwing. */
async function fetchGithubJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  category: string,
  maxCalls: number,
  options: ScanOptions,
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory: category,
    headers,
    signal: options.signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "revert-recurrence",
    subcall: category,
    maxBytes: 512 * 1024,
    maxCallsPerCategory: maxCalls,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint: changed files → per-file recent commit history → revert commits → line-range overlap with
 *  this PR's added lines. Fail-safe: any missing token/invalid slug/failed fetch/aborted signal degrades to []. */
export async function scanRevertRecurrence(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<RevertRecurrenceFinding[]> {
  const { repoFullName, githubToken, files = [] } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return [];
  const [owner, repo] = parts;
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  // Only a file with re-introduced (added) lines can re-tread a reverted region; skip lockfiles/generated/binaries
  // (no informative history) and any file whose patch adds nothing, before spending a round-trip.
  const probes = files
    .filter((file) => !isHistoryUninformativePath(file.path))
    .map((file) => ({ path: file.path, added: diffLineRanges(file.patch ?? "", "+") }))
    .filter((probe) => probe.added.length > 0)
    .slice(0, MAX_FILES_PROBED);

  const findings: RevertRecurrenceFinding[] = [];
  let revertLookups = 0;

  for (const probe of probes) {
    if (options.signal?.aborted) break;
    const commitsUrl =
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
      `?path=${encodeURIComponent(probe.path)}&per_page=${COMMITS_PER_FILE}`;
    const commits = await fetchGithubJson<CommitListItem[]>(
      commitsUrl,
      headers,
      fetchFn,
      "github-commits",
      MAX_FILES_PROBED,
      options,
    );
    if (!Array.isArray(commits)) continue;

    for (const commit of commits) {
      if (revertLookups >= MAX_REVERT_LOOKUPS) break;
      const sha = commit.sha;
      const message = commit.commit?.message ?? "";
      if (typeof sha !== "string" || !isRevertCommit(message)) continue;
      revertLookups += 1;
      const detailUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
      const detail = await fetchGithubJson<CommitDetail>(
        detailUrl,
        headers,
        fetchFn,
        "github-commit-detail",
        MAX_REVERT_LOOKUPS,
        options,
      );
      const filePatch = detail?.files?.find((file) => file.filename === probe.path)?.patch;
      if (!filePatch) continue;
      const overlap = firstOverlap(probe.added, diffLineRanges(filePatch, "-"));
      if (!overlap) continue;
      const finding: RevertRecurrenceFinding = {
        file: probe.path,
        line: overlap.start,
        revertShaPrefix: sha.slice(0, 7),
      };
      const pr = revertedPrNumber(message);
      if (pr !== undefined) finding.revertedPr = pr;
      findings.push(finding);
      break; // one finding per file — the most recent revert whose removed region this PR re-introduces
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}
