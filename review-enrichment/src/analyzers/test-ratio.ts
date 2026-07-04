// Test-to-code ratio analyzer (#2024). From the diff alone (no network, no repo checkout), computes how many
// source lines/files a PR adds versus how many test lines/files it adds, and flags when a MATERIAL source change
// ships with disproportionately little (or zero) accompanying test change. A cheap, always-available complement
// to the coverage-delta analyzer (#1516) that works even when no CI coverage artifact exists. Pure compute over
// `req.files` (path + additions, both already provided by the PR-files API) — no diff/patch parsing, so it
// cannot suffer a patch scanner's edge cases. Fail-safe: no files yields no finding.
import type { EnrichRequest, TestRatioFinding } from "../types.js";

// A material source change below this many added lines isn't enough signal to judge test coverage by ratio —
// a 3-line fix doesn't need a proportional test file.
const MATERIAL_SOURCE_LINES = 20;
// Below this fraction of test-added to source-added lines, the change is flagged as under-tested.
const RATIO_THRESHOLD = 0.3;

// Source-code extensions this ratio is meaningful for — every extension any TEST_* pattern below can match,
// so no test-path pattern is unreachable; docs, config, and data files are neither "source" nor "test" for
// this analyzer and are excluded from both sums.
const SOURCE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "go", "rb", "dart",
  "java", "kt", "kts", "scala", "groovy", "cs", "swift", "php",
  "rs", "c", "cc", "cpp", "h", "hpp",
]);

// Test-path conventions, deliberately kept byte-for-byte identical to src/signals/test-evidence.ts's own
// `isTestPath` (root src/, not importable from here — review-enrichment is a separate package with no
// dependency on the root app). A prior version of this file re-derived these patterns from memory instead of
// copying them and silently dropped the `*_test.py`/`*_test.rb`/`*_test.dart` suffix forms, `__snapshots__/`,
// and the Cypress/Playwright `.cy./.e2e.` suffix — keep this list in sync with the original by copying it
// verbatim, not by re-deriving it, if the original ever changes.
const TEST_DIR_RE = /(^|\/)(test|tests|spec|__tests__)\//i;
const TEST_SRC_TEST_DIR_RE = /(^|\/)src\/test\//i;
const TEST_UNDERSCORE_SUFFIX_RE = /(^|\/)[^/]+_test\.(go|py|rb|dart)$/i;
const TEST_PY_PREFIX_RE = /(^|\/)test_[^/]*\.py$/i;
const TEST_RB_SPEC_SUFFIX_RE = /(^|\/)[^/]+_spec\.rb$/i;
const TEST_DOT_SUFFIX_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs)$/i;
const TEST_CY_E2E_RE = /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const TEST_JVM_SUFFIX_RE = /(^|\/)\w*(Tests?|Spec)\.(java|kt|kts|scala|cs|swift|groovy|php)$/;
const TEST_SNAPSHOTS_DIR_RE = /(^|\/)__snapshots__\//i;

/** Whether `path` matches an established test-file naming convention. Pure. */
export function isTestPath(path: string): boolean {
  return (
    TEST_DIR_RE.test(path) ||
    TEST_SRC_TEST_DIR_RE.test(path) ||
    TEST_UNDERSCORE_SUFFIX_RE.test(path) ||
    TEST_PY_PREFIX_RE.test(path) ||
    TEST_RB_SPEC_SUFFIX_RE.test(path) ||
    TEST_DOT_SUFFIX_RE.test(path) ||
    TEST_CY_E2E_RE.test(path) ||
    TEST_JVM_SUFFIX_RE.test(path) ||
    TEST_SNAPSHOTS_DIR_RE.test(path)
  );
}

function sourceExtOf(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

/** Pure reduction: a PR's changed files → a test-to-code ratio finding, emitted only when the source change is
 *  material (>= MATERIAL_SOURCE_LINES added) AND the test-to-source ratio is under RATIO_THRESHOLD. A docs/config-
 *  only PR (no recognized source extension) is never material, regardless of how many lines it adds. Pure. */
export function evaluateTestRatio(
  files: Array<{ path: string; additions?: number }>,
): TestRatioFinding[] {
  let sourceAdded = 0;
  let testAdded = 0;
  let sourceFiles = 0;
  let testFiles = 0;

  for (const file of files) {
    // A file only counts toward EITHER bucket if it is itself a recognized source-code file — a JSON/YAML
    // fixture or snapshot living under a test/ directory is not test CODE, and must not silently inflate
    // testAdded and suppress a finding for a material source-only change.
    const ext = sourceExtOf(file.path);
    if (!ext || !SOURCE_EXTS.has(ext)) continue;
    const additions = file.additions ?? 0;
    if (isTestPath(file.path)) {
      testAdded += additions;
      testFiles += 1;
    } else {
      sourceAdded += additions;
      sourceFiles += 1;
    }
  }

  if (sourceAdded < MATERIAL_SOURCE_LINES) return [];

  const ratio = testAdded / sourceAdded;
  if (ratio >= RATIO_THRESHOLD) return [];

  return [{ sourceAdded, testAdded, sourceFiles, testFiles, ratio, belowThreshold: true }];
}

/** Analyzer entrypoint: a PR's changed files → a test-to-code ratio finding. No network — pure compute over
 *  `req.files`. Fail-safe: no files yields no finding. */
export async function scanTestRatio(req: EnrichRequest): Promise<TestRatioFinding[]> {
  return evaluateTestRatio(req.files ?? []);
}
