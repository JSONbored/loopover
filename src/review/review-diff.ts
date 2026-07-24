// Bounded, source-first, hunk-aware unified-diff builder for the AI reviewers.
// Ported from reviewbot (the source-of-truth engine, src/core/diff.ts). The previous loopover builder
// was a blind head-slice that `break`-DROPPED whole files on overflow with no priority ordering — so on a
// multi-file PR the file that DEFINES a symbol could be dropped while another file references it, and the
// model then hallucinated "missing import / undefined symbol" (the metagraphed #1528 false-positive class,
// which survived even with full-file grounding on). This builder orders source-first, reduces oversized
// patches hunk-aware instead of dropping them, and always lists patch-less/over-budget files. (#accuracy-gap-1)

import { isLockfile } from "../signals/path-matchers";
import { isTestPath } from "../signals/test-evidence";
import type { listPullRequestFiles } from "../db/repositories";

/** Char budget of the diff fed to the review models. The 120B review models have ~128k-token context, so
 *  even a large PR fits in ONE coherent pass (accuracy over speed). Only a genuinely huge PR truncates —
 *  and then SOURCE survives via priority ordering. */
export const DEFAULT_DIFF_BUDGET = 80_000;

/** Review priority for diff ordering. When the budget is tight, SOURCE survives and
 *  lockfiles/generated/docs/tests are dropped first (least useful to a code reviewer). Lower = kept.
 *  Test detection delegates to the canonical `isTestPath` so this matcher can't drift from it — the
 *  previous inline regex missed real conventions (pytest `test_*.py`, Go `*_test.go`, Ruby `*_spec.rb`,
 *  Cypress/Playwright `.cy`/`.e2e`, a bare `spec/` dir), so those tests were ranked as SOURCE(0) and
 *  could displace real source under a tight budget — the exact opposite of this function's job.
 *  Lockfile detection delegates to the canonical `isLockfile`/`LOCKFILE_NAMES` for the same reason: a
 *  hand-duplicated name list silently misses every future ecosystem addition to the shared set (which has
 *  been extended in batches before), ranking a new lockfile format as SOURCE(0) instead of GENERATED(4). */
export function diffFilePriority(path: string): number {
  // Only the lockfile-NAME portion is delegated; the suffix-based generated-file patterns stay inline.
  if (isLockfile(path) || /\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
  if (/(^|\/)(dist|build|out|coverage|vendor|node_modules)\//i.test(path)) return 4;
  if (/\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i.test(path)) return 2;
  if (isTestPath(path)) return 1;
  return 0; // source code
}

/** Added (`+`) line count in a patch — the substantive-change signal (context/removed lines are noise). */
export function addedLineCount(patch: string | undefined): number {
  if (!patch) return 0;
  let n = 0;
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) n += 1;
  return n;
}

/** The actual TEXT of every added (`+`) line in a patch, in order, with the leading `+` stripped — the
 *  content-level counterpart to {@link addedLineCount} (used by the copycat/plagiarism containment engine,
 *  #1969, which needs the real line text to shingle-compare, not just a count). Empty for a missing/absent
 *  patch (binary/too-large file — same "no comparable content" convention `addedLineCount` uses). */
export function extractAddedLines(patch: string | undefined): string[] {
  if (!patch) return [];
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  return added;
}

function numericAddedLineCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Sum added-line counts across a PR file list — used by auto-review size-cap eligibility (#2065). */
export function totalAddedLineCount(
  files: readonly {
    additions?: number | null | undefined;
    patch?: string | null | undefined;
    payload?: { additions?: unknown; patch?: unknown } | null | undefined;
  }[],
): number {
  let total = 0;
  for (const file of files) {
    const metadataCount =
      numericAddedLineCount(file.additions) ?? numericAddedLineCount(file.payload?.additions);
    const patch =
      file.patch ?? (typeof file.payload?.patch === "string" ? file.payload.patch : undefined);
    total += metadataCount ?? addedLineCount(patch);
  }
  return total;
}

/** Split a unified patch into hunks (each starting at an `@@` header); any preamble stays as hunk 0. */
function splitHunks(patch: string): string[] {
  const hunks: string[] = [];
  let cur: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") && cur.length > 0) {
      hunks.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) hunks.push(cur.join("\n"));
  return hunks;
}

/**
 * Fit a file's patch into `budget` chars by keeping the HIGHEST-SIGNAL hunks (most added lines) and
 * dropping lower-signal ones — so when a big file must be cut, the reviewer keeps the added logic and
 * loses boilerplate/context, instead of a blind head-slice that drops whatever is at the tail. Kept
 * hunks are emitted in original order so the diff still reads top-to-bottom.
 */
export function keepHighSignalHunks(patch: string, budget: number): string {
  if (budget <= 0) return "… (this file's diff truncated)";
  const hunks = splitHunks(patch);
  if (hunks.length <= 1) {
    return patch.length > budget ? `${patch.slice(0, budget)}\n… (this file's diff truncated)` : patch;
  }
  const ranked = hunks.map((h, i) => ({ i, len: h.length, sig: addedLineCount(h) })).sort((a, b) => b.sig - a.sig);
  const keep = new Set<number>();
  let used = 0;
  for (const r of ranked) {
    // Kept hunks are emitted with `.join("\n")` below — N hunks use N-1 separators — so charge the
    // separator only for hunks AFTER the first. Charging `+ 1` for every hunk over-counted the output by
    // one and dropped a hunk that fit exactly at the budget boundary.
    const sep = keep.size > 0 ? 1 : 0;
    if (used + r.len + sep > budget) continue;
    keep.add(r.i);
    used += r.len + sep;
  }
  const top = ranked[0];
  if (keep.size === 0 && top) keep.add(top.i); // always keep the single highest-signal hunk
  const dropped = hunks.length - keep.size;
  const kept = hunks.filter((_, i) => keep.has(i)).join("\n");
  return dropped > 0 ? `${kept}\n… (${dropped} lower-signal hunk(s) dropped)` : kept;
}

/** A changed file, shape-agnostic so any caller's file record can map into it. The explicit `| undefined`
 *  unions let a caller pass through possibly-undefined fields under exactOptionalPropertyTypes. */
export interface ReviewDiffFile {
  path: string;
  patch?: string | undefined;
  status?: string | null | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

/**
 * Build a bounded unified-diff string from ALL changed files. Files are ordered by review priority
 * (SOURCE first), then by added-line count, so if the budget is hit lockfiles/generated/docs/tests drop
 * before source — the file defining a symbol is never silently dropped while another references it.
 * Oversized files keep their highest-signal hunks (not a blind head-slice); patch-less files (binary /
 * too large) are still listed with status + add/del counts so the change is never invisible.
 */
export function buildUnifiedReviewDiff(files: ReviewDiffFile[], budget: number = DEFAULT_DIFF_BUDGET): string {
  const ordered = [...files].sort(
    (a, b) => diffFilePriority(a.path) - diffFilePriority(b.path) || addedLineCount(b.patch) - addedLineCount(a.patch),
  );
  let diff = "";
  for (const file of ordered) {
    const status = file.status ?? "modified";
    const header = `### ${file.path} (${status}) +${file.additions ?? 0}/-${file.deletions ?? 0}\n`;
    const remaining = budget - diff.length;
    if (remaining < 240) {
      diff += `### …diff truncated (${files.length} files total)\n`;
      break;
    }
    if (!file.patch) {
      diff += `${header}(no inline patch — binary or too large)\n\n`;
      continue;
    }
    let body = file.patch;
    if (header.length + body.length + 2 > remaining) {
      // Hunk-aware: keep the highest-signal hunks that fit rather than a blind head-slice.
      body = keepHighSignalHunks(file.patch, remaining - header.length - 4);
    }
    diff += `${header}${body}\n\n`;
  }
  return diff.trim();
}

/** Build a bounded unified-diff string from cached PR files for the AI reviewer. Caps total size so a
 *  huge PR cannot blow the model context or the neuron budget; each file's patch is taken from the raw
 *  GitHub file payload when present. */
export function buildAiReviewDiff(
  files: Awaited<ReturnType<typeof listPullRequestFiles>>,
): string {
  // Source-first + hunk-aware + always-list-dropped-files (ported from reviewbot). The old blind 60k
  // head-slice `break`-dropped whole files in stored order, so the file DEFINING a symbol could vanish
  // while another referenced it → the model hallucinated "missing import / undefined symbol" (the #1528
  // class, which survived even with grounding on). (#accuracy-gap-1)
  return buildUnifiedReviewDiff(
    files.map((file) => ({
      path: file.path,
      patch:
        typeof file.payload?.patch === "string"
          ? file.payload.patch
          : undefined,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
  );
}

/**
 * Build the complete inline patch corpus for deterministic secret scanning. Unlike {@link buildAiReviewDiff},
 * this is intentionally unbudgeted and does not reorder files or drop hunks: security controls must inspect
 * every raw patch GitHub returned instead of the lossy AI-review prompt view.
 *
 * GitHub omits inline `patch` for binary/large files; {@link enrichSecretScanFilesWithPatchFallback} recovers
 * scannable `+` lines for those files before this runs (see {@link maybeAddSecretLeakFinding}).
 */
export function buildSecretScanDiff(
  files: Awaited<ReturnType<typeof listPullRequestFiles>>,
): string {
  return files
    .map((file) => {
      const status = file.status ?? "modified";
      const header = `### ${file.path} (${status}) +${file.additions ?? 0}/-${file.deletions ?? 0}`;
      const patch =
        typeof file.payload?.patch === "string" ? file.payload.patch : "";
      return patch ? `${header}\n${patch}` : header;
    })
    .join("\n\n")
    .trim();
}
