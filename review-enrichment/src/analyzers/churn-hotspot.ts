// Churn-hotspot + bug-density scorer (#1513). Flags changed files that are statistical churn hotspots — high
// commit frequency AND a high fraction of fix/revert commits in recent history — fragile areas where defects
// cluster, so the reviewer scrutinizes harder. This is heavy/historical analysis the no-checkout headless
// `claude --print` reviewer cannot do (it would need the git log); the REES returns it as a brief block.
//
// Data source: GitHub REST `GET /repos/{owner}/{repo}/commits?path=<file>&since=<90d>&per_page=100` per changed
// file; commit subjects are classified locally (free with an installation token). Distinct from #1478's
// author-track-record, which grades the submitter; this grades the FILE.
//
// Fail-safe: returns [] on any network error, non-ok response, or missing token. One file's fetch failure does
// not abort the rest. Abort signals propagate as `analyzer_aborted` so the orchestrator marks the brief partial.
import type { EnrichRequest, ChurnHotspotFinding } from "../types.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // rejects `..` and other path-traversal segments
// Fan-out cap (one GitHub call per changed file). Bounded so a large diff cannot exhaust the shared REST budget;
// the busiest files — the ones a reviewer most needs flagged — sort to the front at render time anyway.
const MAX_FILES_REPORTED = 15;
const LOOKBACK_DAYS = 90;
const PER_PAGE = 100;
// A hotspot has MEANINGFUL recent traffic (a file touched twice is not a defect cluster) AND a high fix/revert
// fraction (defects cluster where fixes keep landing). The two together keep the signal high-precision: a busy
// file with few fixes is just active, and a quiet file with two fix commits is not a cluster.
const MIN_COMMITS = 10;
const MIN_FIX_REVERT_RATE = 0.3;

// Commit-subject classifier: true when the subject reads as a defect fix or a revert. Matches Conventional
// Commit `fix:` / `fix(scope):`, git's `Revert "…"` prefix, and common `bugfix` / `hotfix` variants. Anchored
// to the subject start (the `\b` after the prefix keeps `prefix-fix-thing` from tripping) and case-insensitive.
// The body is never inspected — a body mention of "fix" would destroy precision.
const FIX_REVERT_RE = /^\s*(?:fix\b|revert\b|bugfix\b|hotfix\b)/i;

/** True when a commit message's subject (first line) reads as a defect fix or a revert. Pure. */
export function isFixOrRevertCommit(message: string | null | undefined): boolean {
  if (!message) return false;
  const subject = message.split("\n", 1)[0] ?? message;
  return FIX_REVERT_RE.test(subject);
}

/** Tally a file's recent commit messages into a (total, fixRevert) pair. Pure + total. */
export function tallyCommits(messages: Array<string | null | undefined>): { total: number; fixRevert: number } {
  let total = 0;
  let fixRevert = 0;
  for (const message of messages) {
    total += 1;
    if (isFixOrRevertCommit(message)) fixRevert += 1;
  }
  return { total, fixRevert };
}

/** A file is a churn hotspot when it carries meaningful commit frequency AND a high fix/revert fraction.
 *  Pure + total; the thresholds are the committed defaults (a deployment may tighten them privately). */
export function isHotspot(total: number, fixRevert: number): boolean {
  if (total < MIN_COMMITS) return false;
  return fixRevert / total >= MIN_FIX_REVERT_RATE;
}

type ScanLimits = {
  maxFiles?: number;
  signal?: AbortSignal;
};

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

/** Fetch up to PER_PAGE recent commit messages for one file path. Returns [] on any error (fail-safe). */
async function fetchFileCommits(
  repoOwner: string,
  repoName: string,
  path: string,
  sinceIso: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Array<string | null>> {
  const url = `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(sinceIso)}&per_page=${PER_PAGE}`;
  const resp = await fetchFn(url, { headers, signal });
  if (!resp.ok) return [];
  const data = (await resp.json()) as Array<{ commit?: { message?: string } } | null>;
  return data.map((entry) => entry?.commit?.message ?? null);
}

/** Analyzer entrypoint: report changed files that are churn hotspots, busiest (highest fix/revert rate) first. */
export async function scanChurnHotspots(
  req: EnrichRequest,
  fetchFn: typeof fetch,
  options: ScanOptions = {},
): Promise<ChurnHotspotFinding[]> {
  const { repoFullName, githubToken, files = [] } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const repoOwner = parts[0];
  const repoName = parts[1];
  if (!repoOwner || !repoName || !SLUG_RE.test(repoOwner) || !SLUG_RE.test(repoName)) return [];

  const maxFiles = Math.max(0, options.limits?.maxFiles ?? MAX_FILES_REPORTED);
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const findings: ChurnHotspotFinding[] = [];
  let scanned = 0;
  for (const file of files) {
    if (options.signal?.aborted) throw new Error("analyzer_aborted");
    if (scanned >= maxFiles) break;
    scanned += 1;
    let messages: Array<string | null>;
    try {
      messages = await fetchFileCommits(repoOwner, repoName, file.path, sinceIso, headers, fetchFn, options.signal);
    } catch (error) {
      // An abort must propagate so the orchestrator marks the brief partial; any other network error is one
      // file's transient failure — skip it and keep scanning the rest.
      if (options.signal?.aborted) throw new Error("analyzer_aborted");
      void error;
      continue;
    }
    const { total, fixRevert } = tallyCommits(messages);
    if (!isHotspot(total, fixRevert)) continue;
    findings.push({
      file: file.path,
      commits: total,
      fixRevertCommits: fixRevert,
      fixRevertRate: Number((fixRevert / total).toFixed(2)),
    });
  }

  findings.sort((a, b) => b.fixRevertRate - a.fixRevertRate || b.commits - a.commits);
  return findings;
}
