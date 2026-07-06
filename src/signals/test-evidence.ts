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

// #2187 (foundational slice of #1972 — boundary-safe test generation): a small, precise framework list, each
// tied to an unambiguous marker file/pattern and an existing isTestPath naming family. Deliberately narrow —
// a longer list of guessable-but-ambiguous frameworks would make detectTestConvention's output less trustworthy
// as a test-gen input than returning null (see the "unknown => null" fail-safe below).
export const TEST_FRAMEWORKS = ["vitest", "jest", "pytest", "go-test", "rspec", "cargo-test"] as const;
export type TestFramework = (typeof TEST_FRAMEWORKS)[number];

/** Deterministic detection result: which framework, where tests live, and the file-naming convention to
 *  follow when scaffolding a new one. `testDir` is `null` for a co-located convention (e.g. Go/Rust/Dart's
 *  `_test`/`#[cfg(test)]` siblings), matching how those ecosystems actually lay out tests. */
export type TestConvention = {
  framework: TestFramework;
  testDir: string | null;
  namingPattern: string;
};

// One marker file per framework, checked against the basename of each changed/known path. Ordered by
// specificity where two frameworks could share an ecosystem (vitest before jest: a repo migrating from Jest to
// Vitest keeps `jest.config.js` around far more often than the reverse, so vitest's own config marker — when
// present — must win).
const FRAMEWORK_MARKERS: ReadonlyArray<{ framework: TestFramework; pattern: RegExp; testDir: string | null; namingPattern: string }> = [
  { framework: "vitest", pattern: /(^|\/)vitest\.config\.(ts|mts|cts|js|mjs|cjs)$/i, testDir: "test/", namingPattern: "*.test.ts" },
  { framework: "vitest", pattern: /(^|\/)vitest\.workspace\.(ts|mts|cts|js|mjs|cjs)$/i, testDir: "test/", namingPattern: "*.test.ts" },
  { framework: "jest", pattern: /(^|\/)jest\.config\.(ts|js|mjs|cjs|json)$/i, testDir: "__tests__/", namingPattern: "*.test.js" },
  { framework: "pytest", pattern: /(^|\/)pytest\.ini$/i, testDir: null, namingPattern: "test_*.py" },
  { framework: "pytest", pattern: /(^|\/)pyproject\.toml$/i, testDir: null, namingPattern: "test_*.py" },
  { framework: "go-test", pattern: /(^|\/)go\.mod$/i, testDir: null, namingPattern: "*_test.go" },
  { framework: "rspec", pattern: /(^|\/)\.rspec$/i, testDir: "spec/", namingPattern: "*_spec.rb" },
  { framework: "cargo-test", pattern: /(^|\/)Cargo\.toml$/i, testDir: null, namingPattern: "#[cfg(test)] mod tests" },
];

// Fallback inference from an EXISTING test file's own naming, when no marker is present (e.g. a marker file
// wasn't part of the changed/known set passed in, but the repo already has real test files to imitate).
const CONVENTION_FROM_EXISTING_TEST: ReadonlyArray<{ framework: TestFramework; pattern: RegExp; testDir: string | null; namingPattern: string }> = [
  { framework: "vitest", pattern: /\.(test|spec)\.(ts|tsx|mts|cts)$/i, testDir: "test/", namingPattern: "*.test.ts" },
  { framework: "jest", pattern: /\.(test|spec)\.(js|jsx|mjs|cjs)$/i, testDir: "__tests__/", namingPattern: "*.test.js" },
  { framework: "pytest", pattern: /(^|\/)test_[^/]*\.py$|[^/]+_test\.py$/i, testDir: null, namingPattern: "test_*.py" },
  { framework: "go-test", pattern: /[^/]+_test\.go$/i, testDir: null, namingPattern: "*_test.go" },
  { framework: "rspec", pattern: /[^/]+_spec\.rb$/i, testDir: "spec/", namingPattern: "*_spec.rb" },
];

/**
 * Detect a repo's test framework + convention from a bounded set of changed paths and known marker filenames
 * (e.g. `package.json`, `pyproject.toml`, `go.mod` — paths the caller already has, never fetched by this
 * function). Deterministic and pure: markers win over inferring from existing test-file naming (a config file
 * is a stronger, unambiguous signal than a naming guess), and the marker list is checked in a fixed order so a
 * repo with more than one marker present always resolves to the same framework. Returns `null` when nothing in
 * `paths`/`markers` matches any known convention — an unrecognized layout is left alone (fail-safe) rather than
 * guessing, since a wrong framework guess would make the downstream test-gen spec actively misleading.
 */
export function detectTestConvention(paths: string[], markers: string[]): TestConvention | null {
  for (const marker of FRAMEWORK_MARKERS) {
    if (markers.some((path) => marker.pattern.test(path)) || paths.some((path) => marker.pattern.test(path))) {
      return { framework: marker.framework, testDir: marker.testDir, namingPattern: marker.namingPattern };
    }
  }
  for (const convention of CONVENTION_FROM_EXISTING_TEST) {
    if (paths.some((path) => isTestPath(path) && convention.pattern.test(path))) {
      return { framework: convention.framework, testDir: convention.testDir, namingPattern: convention.namingPattern };
    }
  }
  return null;
}
