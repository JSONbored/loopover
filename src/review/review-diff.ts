// Bounded, source-first, hunk-aware unified-diff builder for the AI reviewers.
// Ported from reviewbot (the source-of-truth engine, src/core/diff.ts). The previous gittensory builder
// was a blind head-slice that `break`-DROPPED whole files on overflow with no priority ordering — so on a
// multi-file PR the file that DEFINES a symbol could be dropped while another file references it, and the
// model then hallucinated "missing import / undefined symbol" (the metagraphed #1528 false-positive class,
// which survived even with full-file grounding on). This builder orders source-first, reduces oversized
// patches hunk-aware instead of dropping them, and always lists patch-less/over-budget files. (#accuracy-gap-1)

import { isTestPath } from "../signals/test-evidence";

/** Char budget of the diff fed to the review models. The 120B review models have ~128k-token context, so
 *  even a large PR fits in ONE coherent pass (accuracy over speed). Only a genuinely huge PR truncates —
 *  and then SOURCE survives via priority ordering. */
export const DEFAULT_DIFF_BUDGET = 80_000;

/** Review priority for diff ordering. When the budget is tight, SOURCE survives and
 *  lockfiles/generated/docs/tests are dropped first (least useful to a code reviewer). Lower = kept.
 *  Test detection delegates to the canonical `isTestPath` so this matcher can't drift from it — the
 *  previous inline regex missed real conventions (pytest `test_*.py`, Go `*_test.go`, Ruby `*_spec.rb`,
 *  Cypress/Playwright `.cy`/`.e2e`, a bare `spec/` dir), so those tests were ranked as SOURCE(0) and
 *  could displace real source under a tight budget — the exact opposite of this function's job. */
export function diffFilePriority(path: string): number {
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum|go\.work\.sum|uv\.lock|packages\.lock\.json|flake\.lock|deno\.lock|pubspec\.lock|podfile\.lock|mix\.lock|package\.resolved|gradle\.lockfile|pdm\.lock|conan\.lock|pixi\.lock|cartfile\.resolved|gopkg\.lock|shard\.lock|rebar\.lock|renv\.lock|chart\.lock)$|\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
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
