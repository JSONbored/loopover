import {
  classifyTestCoverage,
  hasLocalTestEvidence,
  isCodeFile,
  isTestPath,
  type TestCoverageClassification,
} from "./test-evidence";

/**
 * Deterministic, source-free test-evidence self-check (#2235). Surfaces the engine's
 * changed-path -> coverage classifier (src/signals/test-evidence.ts) as a structured report an
 * agent can consult BEFORE opening a PR: "do my changed files carry enough test evidence?".
 *
 * Pure and read-only: it computes solely over the caller-supplied path metadata (no source
 * content, no repo access, no env). Branchless by construction so the MCP handler that wraps it
 * stays trivially patch-coverable.
 */
export type TestEvidenceReport = {
  /** Coarse coverage band from the shared classifier: strong | adequate | weak | absent. */
  coverageBand: TestCoverageClassification;
  /** Number of distinct changed paths considered (changedPaths plus any explicit testFiles, deduped). */
  changedPathCount: number;
  /** How many of the considered paths are themselves test files. */
  testPathCount: number;
  /** Whether any changed path is hand-authored program source (i.e. tests may be expected). */
  hasCodeChanges: boolean;
  /** Whether any local test evidence was supplied (changed test files or explicit test paths). */
  hasTestEvidence: boolean;
  /** One actionable, public-safe guidance line keyed off the coverage band. */
  guidance: string;
  /** One-sentence public-safe summary. */
  summary: string;
};

// Total map over every TestCoverageClassification value, so the report builder needs no branch to
// select guidance (a missing key would be a compile error via the Record type).
const TEST_EVIDENCE_GUIDANCE: Record<TestCoverageClassification, string> = {
  strong:
    "Strong test coverage accompanies this change - no additional tests are required for the coverage gate.",
  adequate:
    "Test coverage is adequate - consider one more case for the primary changed path to strengthen the diff.",
  weak: "Test coverage is weak relative to the changed surface - add tests for the untested code paths to clear the coverage gate.",
  absent:
    "No test files are present in the changed set - add at least one test exercising the changed code before opening the PR.",
};

/**
 * Build the structured test-evidence report for a set of changed paths and optional explicit test
 * paths. Deterministic and branchless: delegates every classification decision to the shared
 * (already-tested) engine classifiers so this layer only assembles their results.
 */
export function buildTestEvidenceReport(changedPaths: string[], testFiles?: string[]): TestEvidenceReport {
  // Fold the caller's optional explicit test paths into the single changed-path set that EVERY signal below is
  // computed from, so coverageBand/guidance can never contradict hasTestEvidence (both inputs describe the same
  // change; testFiles just lets a caller flag test paths separately). Deduped so a path listed in both is not
  // double-counted in the coverage ratio.
  const allPaths = Array.from(new Set([...changedPaths, ...(testFiles ?? [])]));
  const coverageBand = classifyTestCoverage(allPaths);
  const testPathCount = allPaths.filter(isTestPath).length;
  const hasCodeChanges = allPaths.some(isCodeFile);
  const hasTestEvidence = hasLocalTestEvidence({ testFiles: allPaths });
  return {
    coverageBand,
    changedPathCount: allPaths.length,
    testPathCount,
    hasCodeChanges,
    hasTestEvidence,
    guidance: TEST_EVIDENCE_GUIDANCE[coverageBand],
    summary: `Test-evidence check: ${coverageBand} coverage across ${allPaths.length} changed path(s), ${testPathCount} test file(s).`,
  };
}
