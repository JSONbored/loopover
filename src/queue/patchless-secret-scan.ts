import type { FileFetcher } from "../review/review-grounding";
import { mapWithConcurrency } from "./map-with-concurrency";
import type { AdvisoryFinding, PullRequestFileRecord } from "../types";

/** Per-file cap when synthesizing a patch for GitHub's patch-less (binary/large) PR files. The fetcher behind
 *  this (grounding-wire.ts's makeGithubFileFetcher) requests the `application/vnd.github.raw+json` media type
 *  specifically to bypass the Contents API's ~1MB base64-JSON envelope ceiling, so this cap is the real limit,
 *  not GitHub's. Raised from 512_000 (2026-07-25): a repo whose regenerated OpenAPI/JSON-schema artifacts
 *  routinely exceed 512KB (observed live: metagraphed's openapi.json at ~1.9MB, api-components.schema.json at
 *  ~514KB) was hitting the fail-closed `secretScanIncomplete` block on every such PR even though the file is
 *  deterministically generated from already-scanned source in the same diff. Raising this cap only EXPANDS scan
 *  coverage (more content becomes fetchable-and-scannable instead of being marked incomplete-and-blocked) --
 *  it never reduces detection on anything previously caught. 4MB gives real headroom above the largest
 *  observed case without being unbounded; fetch count/concurrency stay capped separately below. */
export const SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS = 4_000_000;
/** Fetch probe limit passed to {@link FileFetcher.getFileContent}: the grounding fetcher returns `maxChars+1`
 *  bytes when the file exceeds `maxChars - 1`, so `content.length > SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS` reliably
 *  detects truncation instead of scanning a clipped prefix. Mirrors review-grounding's `+ 1` probe. */
const SECRET_SCAN_FETCH_PROBE_CHARS = SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS + 1;
/** Bound concurrent Contents API reads during patch-less secret-scan enrichment. */
const SECRET_SCAN_PATCH_FALLBACK_MAX_CONCURRENT = 4;
/** Aggregate Contents API read budget for one PR secret-scan fallback pass. */
export const SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES = 100;
/** Max patch-less paths listed in the fail-closed advisory detail (title still reports the full count). */
export const INCOMPLETE_PATCH_LESS_PATH_DETAIL_MAX = 5;

/** Lines present in `head` but not in `base` (multiset), for scanning only the additions on a modified file. */
export function addedLinesForSecretScan(base: string, head: string): string[] {
  const baseCounts = new Map<string, number>();
  for (const line of base.split("\n")) {
    baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of head.split("\n")) {
    const remaining = baseCounts.get(line) ?? 0;
    if (remaining > 0) {
      baseCounts.set(line, remaining - 1);
    } else {
      added.push(line);
    }
  }
  return added;
}

function syntheticSecretScanPatch(lines: readonly string[]): string {
  return lines.map((line) => `+${line}`).join("\n");
}

function isOverSecretScanContentLimit(content: string): boolean {
  return content.length > SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS;
}

function markPatchLessSecretScanIncomplete<T extends { payload?: Record<string, unknown> }>(file: T): T {
  return {
    ...file,
    payload: { ...file.payload, secretScanIncomplete: true },
  };
}

export function shouldAttemptPatchLessSecretScan(
  file: { previousFilename?: string | null | undefined },
  status: string,
  baseSha?: string | null | undefined,
): boolean {
  if (status === "removed") return false;
  if (status === "added") return true;
  if (status === "renamed") return Boolean(baseSha?.trim() && file.previousFilename?.trim());
  // GitHub's Pull Request Files API `status` can also be `copied` | `changed` | `unchanged`
  // (diff_entry OpenAPI schema). `copied`/`changed` can introduce new committed content relative
  // to base; `unchanged` is still usable in merge-commit contexts where content can differ from
  // what a local diff assumes. Treat all three like `modified`: attempt the base/head multiset
  // scan when `baseSha` is known. Falling through to "never scan" for these statuses used to
  // silently bypass both the content-fetch fallback and the fail-closed `secretScanIncomplete`
  // advisory (#5947).
  if (
    status === "modified" ||
    status === "copied" ||
    status === "changed" ||
    status === "unchanged"
  ) {
    return Boolean(baseSha?.trim());
  }
  return false;
}

export function hasPatchLessSecretScanCandidates(
  files: PullRequestFileRecord[],
  baseSha?: string | null | undefined,
): boolean {
  return files.some((file) => {
    const existingPatch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (existingPatch) return false;
    const status = file.status ?? "modified";
    return shouldAttemptPatchLessSecretScan(file, status, baseSha);
  });
}

function patchLessSecretScanFetchCost(
  file: PullRequestFileRecord,
  baseSha?: string | null | undefined,
): number {
  const existingPatch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
  if (existingPatch) return 0;
  const status = file.status ?? "modified";
  if (!shouldAttemptPatchLessSecretScan(file, status, baseSha)) return 0;
  return status === "added" ? 1 : 2;
}

function patchLessSecretScanFetchCostExceedsBudget(
  files: PullRequestFileRecord[],
  baseSha?: string | null | undefined,
): boolean {
  let fetches = 0;
  for (const file of files) {
    fetches += patchLessSecretScanFetchCost(file, baseSha);
    if (fetches > SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES) return true;
  }
  return false;
}

export function markEligiblePatchLessFilesIncomplete(
  files: PullRequestFileRecord[],
  baseSha?: string | null | undefined,
): PullRequestFileRecord[] {
  return files.map((file) => {
    const existingPatch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (existingPatch) return file;
    const status = file.status ?? "modified";
    if (!shouldAttemptPatchLessSecretScan(file, status, baseSha)) return file;
    return markPatchLessSecretScanIncomplete(file);
  });
}

/** @internal Exported for patch-less secret-scan unit tests only. */
export const patchlessSecretScanInternals = {
  hasPatchLessSecretScanCandidates,
  markEligiblePatchLessFilesIncomplete,
  shouldAttemptPatchLessSecretScan,
  syntheticSecretScanPatch,
  isOverSecretScanContentLimit,
  markPatchLessSecretScanIncomplete,
  patchLessSecretScanFetchCost,
  patchLessSecretScanFetchCostExceedsBudget,
};

export function incompletePatchLessSecretScanFinding(
  files: PullRequestFileRecord[],
): AdvisoryFinding | null {
  const paths = files
    .filter((file) => file.payload?.secretScanIncomplete === true)
    .map((file) => file.path);
  if (paths.length === 0) return null;
  const listedPaths = paths.slice(0, INCOMPLETE_PATCH_LESS_PATH_DETAIL_MAX);
  const pathSummary =
    paths.length > INCOMPLETE_PATCH_LESS_PATH_DETAIL_MAX
      ? `${listedPaths.join(", ")}, and ${paths.length - INCOMPLETE_PATCH_LESS_PATH_DETAIL_MAX} more`
      : listedPaths.join(", ");
  return {
    // #9082: a DIFFERENT code from `secret_leak` deliberately. `secret_leak` (secretLeakFinding, below) means a
    // real, matched credential was found and always hard-blocks with no opt-in -- that contract must stay
    // absolute. This finding means the opposite: verification is INCOMPLETE (GitHub omitted the diff and the
    // fallback fetch failed, was rejected, or exceeded the scan cap) -- absence of evidence, not evidence of a
    // leak. Sharing `secret_leak`'s code routed it through the same unconditional, breaker-exempt hard block
    // (resolveConfiguredGateMode's "secret_leak" branch, advisory.ts), so a Contents API hiccup, a >4MB
    // regenerated artifact, or a rate limit auto-closed a legitimate PR with no live re-check ever getting a
    // chance to clear it. `secret_scan_incomplete` instead falls to resolveConfiguredGateMode's default "off"
    // (advisory.ts) and is caught earlier, in evaluateGateCheckCore's no-deterministic-blocker branch, as a
    // NEUTRAL hold -- like `ai_review_inconclusive`, deliberately checked only when nothing else already
    // hard-blocked, so a REAL secret_leak match elsewhere in the same PR is never buried in this hold.
    code: "secret_scan_incomplete",
    severity: "critical",
    title: `Patch-less file(s) could not be fully scanned for secrets (${paths.length})`,
    detail: `GitHub omitted inline diff for: ${pathSummary}. Fetched content exceeded the ${SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS}-char scan cap or could not be retrieved completely, so leaked-secret verification is incomplete. The gate holds for a human reviewer rather than closing automatically; it re-evaluates once the content becomes retrievable, or shrink the change/split the file so the diff is reviewable.`,
    action: "Ensure patch-less files are within scan limits or split the change so secrets can be verified.",
  };
}

// Bounded-concurrency fan-out over the patch-less files. Delegates to the canonical `mapWithConcurrency`
// (#6602) — the worker-pool loop lives in exactly one place under src/queue and src/signals.
async function mapPatchLessSecretScanFilesWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  return mapWithConcurrency(items, limit, mapper);
}

/** When GitHub omits inline `patch` (binary/large files), fetch post-change content and synthesize `+` lines so
 *  the unconditional `secret_leak` hard blocker can still inspect committed credentials. Added files scan only
 *  genuinely new lines; modified/copied/changed/unchanged/renamed files multiset-diff against base when `baseSha`
 *  is known (`copied`/`changed`/`unchanged` are treated like `modified` — #5947 — so they are never silently
 *  skipped). Unfetchable or baseline-unknown content leaves the file header-only so pre-existing secrets are not
 *  mis-flagged; content over the per-file cap is marked incomplete so the gate fails closed instead of scanning a
 *  truncated prefix.
 */
export async function enrichSecretScanFilesWithPatchFallback(
  files: PullRequestFileRecord[],
  args: {
    headSha?: string | null | undefined;
    baseSha?: string | null | undefined;
    fetcher: FileFetcher;
  },
): Promise<PullRequestFileRecord[]> {
  const headSha = args.headSha?.trim();
  if (!headSha) return files;
  if (patchLessSecretScanFetchCostExceedsBudget(files, args.baseSha)) {
    return markEligiblePatchLessFilesIncomplete(files, args.baseSha);
  }
  return mapPatchLessSecretScanFilesWithConcurrency(
    files,
    SECRET_SCAN_PATCH_FALLBACK_MAX_CONCURRENT,
    async (file) => {
      const status = file.status ?? "modified";
      const existingPatch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
      if (existingPatch) return file;
      const needsFetch = shouldAttemptPatchLessSecretScan(file, status, args.baseSha);
      if (!needsFetch) return file;
      try {
        const headContent = await args.fetcher.getFileContent(
          file.path,
          headSha,
          SECRET_SCAN_FETCH_PROBE_CHARS,
        );
        if (headContent == null) return markPatchLessSecretScanIncomplete(file);
        if (isOverSecretScanContentLimit(headContent)) return markPatchLessSecretScanIncomplete(file);
        let addedLines: string[];
        if (status === "added") {
          addedLines = headContent.split("\n");
        } else if (status === "renamed") {
          const baseSha = args.baseSha!.trim();
          const previousPath = file.previousFilename!.trim();
          const baseContent = await args.fetcher.getFileContent(
            previousPath,
            baseSha,
            SECRET_SCAN_FETCH_PROBE_CHARS,
          );
          if (baseContent == null) return markPatchLessSecretScanIncomplete(file);
          if (isOverSecretScanContentLimit(baseContent)) return markPatchLessSecretScanIncomplete(file);
          addedLines = addedLinesForSecretScan(baseContent, headContent);
        } else {
          const baseContent = await args.fetcher.getFileContent(
            file.path,
            args.baseSha!.trim(),
            SECRET_SCAN_FETCH_PROBE_CHARS,
          );
          if (baseContent == null) return markPatchLessSecretScanIncomplete(file);
          if (isOverSecretScanContentLimit(baseContent)) return markPatchLessSecretScanIncomplete(file);
          addedLines = addedLinesForSecretScan(baseContent, headContent);
        }
        if (addedLines.length === 0) return file;
        return {
          ...file,
          payload: { ...file.payload, patch: syntheticSecretScanPatch(addedLines) },
        };
      } catch {
        return markPatchLessSecretScanIncomplete(file);
      }
    },
  );
}
