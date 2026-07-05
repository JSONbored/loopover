// Deterministic per-PR review-effort estimator (#2068, core of #1955). Pure: given the changed files and their
// patches, weight each file's added-line count by its category, add a fixed per-file overhead, and map the total
// to a 1-5 complexity band plus a rounded minutes estimate. No AI, no IO — identical input always yields the same
// estimate. Consumed by the ROI and unified-comment surfaces; standalone and fully unit-testable.

import { addedLineCount } from "./review-diff";
import { classifyChangedFile, type ChangedFileCategory } from "../signals/path-matchers";

export type ReviewEffortFile = { path: string; patch?: string | undefined };

export type ReviewEffort = {
  /** Complexity band from 1 (trivial) to 5 (heavy). */
  band: 1 | 2 | 3 | 4 | 5;
  /** Rough minutes a human reviewer should budget. */
  minutes: number;
};

// Per-added-line review weight by file category. Genuine source costs the most to review; machine-produced or
// imported content (minified/generated/vendored/lockfiles) the least; docs/config/tests sit in between. A single
// auditable table rather than a branch chain, so the weighting is easy to read and adjust.
const CATEGORY_WEIGHT: Record<ChangedFileCategory, number> = {
  minified: 0.05,
  generated: 0.05,
  vendored: 0.05,
  lockfile: 0.1,
  dependency_manifest: 0.4,
  config: 0.4,
  docs: 0.25,
  test: 0.5,
  source: 1,
  other: 0.5,
};

// A fixed per-file review-overhead: each touched file carries a context-switch cost on top of its lines.
const PER_FILE_OVERHEAD = 3;
// Upper effort bound of bands 1-4; anything larger is band 5. Deliberate, documented cut points — this is a
// triage aid, not a precise measurement.
const BAND_MAX = [10, 40, 120, 300];
// Minutes are half the weighted effort, floored at 1 so any non-empty review reads as at least a minute.
const MINUTES_PER_EFFORT = 0.5;

function bandForEffort(effort: number): 1 | 2 | 3 | 4 | 5 {
  for (let i = 0; i < BAND_MAX.length; i++) {
    if (effort <= BAND_MAX[i]!) return (i + 1) as 1 | 2 | 3 | 4;
  }
  return 5;
}

/** Estimate the review effort of a change set. Pure and deterministic. */
export function estimateReviewEffort(files: ReviewEffortFile[]): ReviewEffort {
  let weighted = 0;
  for (const file of files) {
    weighted += addedLineCount(file.patch) * CATEGORY_WEIGHT[classifyChangedFile(file.path)];
  }
  const effort = weighted + files.length * PER_FILE_OVERHEAD;
  return { band: bandForEffort(effort), minutes: Math.max(1, Math.round(effort * MINUTES_PER_EFFORT)) };
}
