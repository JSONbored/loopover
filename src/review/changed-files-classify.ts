import { isConfigFile, isDocsFile, isGeneratedFile, isLockfile, isMinifiedFile, isVendoredFile } from "../signals/path-matchers";
import { isTestFile } from "../signals/local-branch";
import { isTestPath } from "../signals/test-evidence";

// Deterministic changed-file classifier for the review changed-files summary (#2143, part of #1957). Maps a changed
// file PATH to exactly one of five review-oriented buckets so the summary table (and future analytics) group
// deterministically. Pure + path-only — no diff content, no IO — composing the existing hardened path-matchers.
//
// NOTE: this is DISTINCT from `classifyChangedFile` in src/signals/path-matchers.ts, which returns the finer-grained
// 10-way slop category with a DIFFERENT precedence (it ranks config above test). This review classifier deliberately
// uses its own precedence below, so it can't just fold that one.

/** The five review-summary buckets a changed file maps to. */
export type ReviewFileClass = "source" | "test" | "docs" | "config" | "generated";

/**
 * Classify a changed file path into one review bucket. FIXED precedence — `generated > test > docs > config > source`
 * — so a file matching several buckets (a generated test file, a lockfile, a vendored fixture) always resolves to the
 * higher-precedence class deterministically:
 *  - `generated`: machine-produced/imported output (generated markers, vendored trees, lockfiles, minified bundles) —
 *    never real hand-authored effort, so it outranks everything.
 *  - `test`, `docs`, `config`: the remaining recognized categories, in that order.
 *  - `source`: anything unrecognized (including plain code) falls through here.
 * Pure.
 */
export function classifyChangedFile(path: string): ReviewFileClass {
  if (isGeneratedFile(path) || isVendoredFile(path) || isLockfile(path) || isMinifiedFile(path)) return "generated";
  if (isTestFile(path) || isTestPath(path)) return "test";
  if (isDocsFile(path)) return "docs";
  if (isConfigFile(path)) return "config";
  return "source";
}
