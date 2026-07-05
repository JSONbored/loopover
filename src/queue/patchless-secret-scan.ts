import type { FileFetcher } from "../review/review-grounding";
import type { AdvisoryFinding, PullRequestFileRecord } from "../types";

/** Per-file cap when synthesizing a patch for GitHub's patch-less (binary/large) PR files. */
export const SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS = 512_000;
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
  if (status === "modified") return Boolean(baseSha?.trim());
  if (status === "renamed") return Boolean(baseSha?.trim() && file.previousFilename?.trim());
  return status === "added";
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
    code: "secret_leak",
    severity: "critical",
    title: `Patch-less file(s) could not be fully scanned for secrets (${paths.length})`,
    detail: `GitHub omitted inline diff for: ${pathSummary}. Fetched content exceeded the ${SECRET_SCAN_PATCH_FALLBACK_MAX_CHARS}-char scan cap or could not be retrieved completely, so leaked-secret verification is incomplete. Shrink the change, split the file, or ensure the diff is reviewable before merge.`,
    action: "Ensure patch-less files are within scan limits or split the change so secrets can be verified.",
  };
}

async function mapPatchLessSecretScanFilesWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** When GitHub omits inline `patch` (binary/large files), fetch post-change content and synthesize `+` lines so
 *  the unconditional `secret_leak` hard blocker can still inspect committed credentials. Added files scan only
 *  genuinely new lines; modified/renamed files multiset-diff against base when `baseSha` is known. Unfetchable
 *  or baseline-unknown content leaves the file header-only so pre-existing secrets are not mis-flagged; content
 *  over the per-file cap is marked incomplete so the gate fails closed instead of scanning a truncated prefix.
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
