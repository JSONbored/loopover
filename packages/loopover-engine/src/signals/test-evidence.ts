export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb|dart)$/i.test(file) || // Dart/Flutter `foo_test.dart` co-located with source
    /(^|\/)test_[^/]*\.py$/i.test(file) || // pytest's default `test_*.py` prefix convention (the suffix rule above only catches `*_test.py`)
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs)$/i.test(file) ||
    /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file) ||
    // JVM / C# / Swift / PHP `SomethingTest(s)`/`SomethingSpec` class-suffix convention
    // (JUnit, Kotlin/ScalaTest, Spock, xUnit/NUnit, XCTest, PHPUnit/PHPSpec). Case-sensitive on the
    // PascalCase suffix so it can't false-positive on words that merely end in
    // "test"/"spec" (Latest.java, Contest.cs, manifest.scala, Latest.php).
    /(^|\/)\w*(Tests?|Spec)\.(java|kt|kts|scala|cs|swift|groovy|php)$/.test(file) ||
    /(^|\/)__snapshots__\//i.test(file)
  );
}

// Canonical hand-authored-source extensions — the SOURCE-side sibling of isTestPath's class-suffix rule.
// The two matchers MUST stay symmetric: isTestPath recognizes java/kt/kts/scala/cs/swift/groovy test files,
// so this set lists those same languages. Otherwise a C#/Swift/Groovy/Kotlin-script SOURCE change is classified
// as neither code nor test and silently escapes both the missing-tests gate signals and token scoring.
const SOURCE_FILE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs|kt|kts|scala|java|cs|swift|groovy|go|sql)$/i;

/** True iff `file` is a hand-authored program-source file: a recognized source extension that is not itself a
 *  test file. The single source of truth for every `isCodeFile` in the signals layer, so the source/test
 *  classifiers can never drift (the same way isCodeFile's `isTestFile` wrappers all delegate to isTestPath). */
export function isSourcePath(file: string): boolean {
  return SOURCE_FILE_EXTENSION.test(file) && !isTestPath(file);
}

// Extensions recognized as code outside isSourcePath's core set (php, native, front-end frameworks, Dart).
// isSourcePath owns the JVM/.NET/Swift/Groovy/Kotlin-script set symmetric with isTestPath.
const EXTENDED_SOURCE_EXTENSION = /\.(php|cpp|cc|c|h|hpp|m|vue|svelte|astro|dart)$/i;

/** cs/swift/groovy/kts plus php, C/C++/Objective-C, vue/svelte/astro, and dart — see isSourcePath for the
 *  canonical JVM/.NET/Swift/Groovy/Kotlin-script matcher kept symmetric with isTestPath. Generated Dart part
 *  files (.g.dart/.freezed.dart/.gr.dart) stay non-code (#3724). The single source of truth both the Worker
 *  (src/signals/path-matchers.ts) and the published @loopover/mcp/loopover-miner CLIs delegate
 *  to, so the three previously-independent hand-ports can't silently drift from each other again. */
export function isCodeFile(file: string): boolean {
  if (isSourcePath(file)) return true;
  return EXTENDED_SOURCE_EXTENSION.test(file) && !isTestPath(file) && !/\.(g|freezed|gr)\.dart$/i.test(file);
}

export function hasLocalTestEvidence(input: { tests?: string[] | undefined; testFiles?: string[] | undefined }): boolean {
  return (input.tests ?? []).length > 0 || (input.testFiles ?? []).some((file) => isTestPath(file));
}

// A body can mention testing without having actually done it ("No tests run", "Tests not run", "Not
// tested locally", "did not run any tests") -- the affirmative keyword match below would otherwise treat
// that as passing evidence and let a configured manifest test expectation silently disappear. Rather than
// enumerate ever more literal phrase templates (which a previous version of this function tried, and which
// still missed "Not tested" because its test-noun list didn't include the verb form "tested"), detect
// negation by PROXIMITY: a negation word within a few words of a test/validation stem, in either order,
// with a shared stem definition so the "is this a test/validation mention at all" question is answered
// exactly once. The filler between the negation word and the stem may not cross a clause/sentence boundary
// (a comma, period, exclamation mark, or question mark), so an unrelated "not" earlier in the body (e.g.
// "This is not a breaking change. Tested with npm run test:ci.") cannot suppress a later, unrelated
// affirmative note. A colon, semicolon, or dash is deliberately NOT a hard boundary here -- see
// LABEL_SEPARATOR_GAP below.
const TEST_STEM = "(?:test(?:ed|s|ing)?|validat(?:ion|ed)|verif(?:y|ied|ying)|manual check|smoke(?:\\s+tests?)?)";
const NEGATION_WORD = "(?:no|not|never|without|skip(?:ped)?|didn't|doesn't|isn't|wasn't|weren't|haven't|hasn't)";
const NEGATION_CONTINUATION = "(?:not|never|failed|failing|skipped|incomplete)";
const SAME_SENTENCE_FILLER_WORD = "[^\\s.,!?;]+";
// A label-style status line often glues its separator directly onto the negation word or stem with no
// surrounding whitespace ("Tests: not run.", "Validation; skipped.", "Tests - not run."). The plain
// `\s+` gap below would never match across that punctuation, so the negation went undetected and the
// bare "Tests"/"Validation" keyword fell through to the affirmative check instead (#3304, round 4).
// Allow ONE label separator (colon, semicolon, or a hyphen/en-dash/em-dash) with any trailing
// whitespace to stand in for the mandatory whitespace, but only at the junction touching the negation
// word or stem itself -- every other gap between filler words stays pure whitespace, so a label
// separator elsewhere in the sentence still cannot let a negation reach across unrelated content (the
// filler-word bound below already exists for exactly this reason).
const LABEL_SEPARATOR_GAP = "(?:\\s+|[:;\\-\\u2013\\u2014]\\s*)";

const NEGATES_BEFORE_TEST_STEM = new RegExp(`\\b${NEGATION_WORD}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,3}${TEST_STEM}\\b`, "i");
const NEGATES_AFTER_TEST_STEM = new RegExp(`\\b${TEST_STEM}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,2}${NEGATION_CONTINUATION}\\b`, "i");
// A compound negated adjective with no separating whitespace at all ("untested", "unvalidated", "unverified").
const NEGATES_TEST_STEM_PREFIX = /\bun(?:tested|validated|verified)\b/i;

const AFFIRMATIVE_TEST_MENTION = /\b(test(?:ed|s|ing)?|validation|validated|verified|manual check|smoke|pytest|vitest|npm test|pnpm test|cargo test|go test)\b/i;

// A body can contain BOTH a genuine negated clause ("No tests run locally.") and a separate, later clause
// with real affirmative evidence ("Validated with npm run test:ci.") -- evaluating the negation checks
// against the WHOLE body would let the first clause veto the second, discarding real evidence the manifest
// gate is specifically trying to detect (#3304, round 3). Split on the same clause-boundary punctuation the
// proximity checks already treat as a hard stop -- colon/semicolon/dash are excluded here on purpose
// (#3304, round 4): they are typically a label separator glued directly onto the word on either side
// ("Tests: not run."), and splitting on them would sever the stem from its own negation before the
// proximity checks ever run, the same way the round-3 bug worked one level up. Require at least one
// clause to be an affirmative, non-negated mention -- so an earlier honest "no tests" disclosure can no
// longer suppress later evidence.
export function hasValidationNote(value: string): boolean {
  return value
    .split(/[.,!?]+/)
    .some(
      (clause) =>
        !NEGATES_TEST_STEM_PREFIX.test(clause) &&
        !NEGATES_BEFORE_TEST_STEM.test(clause) &&
        !NEGATES_AFTER_TEST_STEM.test(clause) &&
        AFFIRMATIVE_TEST_MENTION.test(clause),
    );
}

/**
 * Coarse classification of how much test coverage accompanies a set of changed paths.
 * Used by slop signals to weight diffs that touch source but include no tests differently
 * from those with proportionally strong test changes.
 */
export type TestCoverageClassification = "strong" | "adequate" | "weak" | "absent";

export function classifyTestCoverage(changedPaths: string[]): TestCoverageClassification {
  if (changedPaths.length === 0) return "absent";
  const testCount = changedPaths.filter(isTestPath).length;
  if (testCount === 0) return "absent";
  const ratio = testCount / changedPaths.length;
  if (ratio >= 0.4) return "strong";
  if (ratio >= 0.2) return "adequate";
  return "weak";
}

// #2187 (foundational slice of #1972 — boundary-safe test generation): a small, precise framework list.
// Consumed by the MCP test-gen tool's enum (src/mcp/server.ts testGenShape) so a caller cannot request a
// spec for a framework this engine doesn't recognize.
export const TEST_FRAMEWORKS = ["vitest", "jest", "pytest", "go-test", "rspec", "cargo-test"] as const;
export type TestFramework = (typeof TEST_FRAMEWORKS)[number];

/** The test-evidence report shape returned identically by the MCP tool, the REST route, and the CLI mirror. */
export type TestEvidenceReport = {
  classification: TestCoverageClassification;
  changedFileCount: number;
  codeFileCount: number;
  testFileCount: number;
  guidance: string[];
};

/**
 * PURE: classify a planned change's test evidence from path metadata (plus optional free-text `tests` notes) and
 * render actionable guidance. Extracted (#6749) so the remote MCP tool, `POST /v1/lint/test-evidence`, and the
 * local CLI mirror all derive a byte-identical verdict from ONE implementation instead of three drifting copies.
 */
export function buildTestEvidenceReport(input: {
  changedPaths: readonly string[];
  testFiles?: readonly string[] | undefined;
  tests?: string | undefined;
}): TestEvidenceReport {
  const allPaths = [...input.changedPaths, ...(input.testFiles ?? [])];
  const codeFileCount = input.changedPaths.filter(isCodeFile).length;
  let classification = classifyTestCoverage(allPaths);
  let testFileCount = allPaths.filter(isTestPath).length;
  // Credit free-text `tests` evidence (e.g. "ran `go test ./...` locally, no new file") the same way the
  // sibling tools loopover_check_slop_risk / loopover_suggest_boundary_tests already do via
  // hasLocalTestEvidence. Only ever LIFT an otherwise-"absent" verdict -- never make this more lenient than
  // the path-based signal once real test-file evidence (weak/adequate/strong) already exists.
  const creditedByFreeTextTests = classification === "absent" && hasLocalTestEvidence({ tests: input.tests, testFiles: input.testFiles });
  if (creditedByFreeTextTests) {
    classification = "adequate";
    testFileCount = Math.max(testFileCount, 1);
  }
  const guidance: string[] = [];
  if (codeFileCount === 0) {
    guidance.push("No hand-authored code files changed, so the missing-test-evidence signal does not apply (e.g. a docs- or config-only change).");
  } else if (creditedByFreeTextTests) {
    guidance.push("No test file was detected among the changed paths, but the free-text `tests` evidence you supplied is credited as test evidence (the same way check_slop_risk and suggest_boundary_tests treat it).");
  } else if (classification === "absent") {
    guidance.push("Changed code files carry no test evidence — add or update a test that exercises the change before opening the PR.");
  } else if (classification === "strong") {
    guidance.push("Test coverage looks strong for this change.");
  } else {
    guidance.push(`Test coverage is ${classification} for this change — adding another focused test would strengthen the evidence.`);
  }
  return { classification, changedFileCount: allPaths.length, codeFileCount, testFileCount, guidance };
}
