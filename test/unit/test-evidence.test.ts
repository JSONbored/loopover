import { describe, expect, it } from "vitest";
import { classifyTestCoverage, detectTestConvention, hasLocalTestEvidence, hasValidationNote, isTestPath } from "../../src/signals/test-evidence";

describe("test evidence helpers", () => {
  it("detects common test path conventions", () => {
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("spec/models/widget_spec.rb")).toBe(true);
    expect(isTestPath("src/test/helpers.ts")).toBe(true);
    expect(isTestPath("tests/integration/api.test.ts")).toBe(true);
    expect(isTestPath("__tests__/widget.spec.tsx")).toBe(true);
    expect(isTestPath("e2e/login.spec.ts")).toBe(true);
    expect(isTestPath("integration/api_flow.cy.ts")).toBe(true);
    expect(isTestPath("playwright/smoke.spec.ts")).toBe(true);
    expect(isTestPath("cypress/e2e/checkout.cy.js")).toBe(true);
    // Cypress/Playwright e2e tests in Node/TS module extensions.
    expect(isTestPath("cypress/e2e/checkout.cy.mts")).toBe(true);
    expect(isTestPath("e2e/flow.e2e.mjs")).toBe(true);
    expect(isTestPath("components/__snapshots__/Card.tsx.snap")).toBe(true);
    // .test/.spec files in Node/TS ESM + CommonJS module extensions.
    expect(isTestPath("src/loader.test.mts")).toBe(true);
    expect(isTestPath("src/legacy.spec.cjs")).toBe(true);
    expect(isTestPath("src/config.test.cts")).toBe(true);
    expect(isTestPath("src/widget.spec.mjs")).toBe(true);
    expect(isTestPath("src/state.snap")).toBe(false);
    expect(isTestPath("src/widget.rs")).toBe(false);
  });

  it("detects pytest's default test_*.py prefix convention, not just the *_test.py suffix", () => {
    expect(isTestPath("mypackage/test_utils.py")).toBe(true); // pytest default, sitting next to source
    expect(isTestPath("src/app/test_auth.py")).toBe(true);
    expect(isTestPath("test_top_level.py")).toBe(true); // repo-root test file
    expect(isTestPath("internal/cache_test.py")).toBe(true); // the pre-existing suffix form still matches
    expect(isTestPath("src/app/latest_config.py")).toBe(false); // `test_` mid-segment ⇒ not a test
    expect(isTestPath("src/app/testing.py")).toBe(false); // no `test_` boundary ⇒ not a test
  });

  it("detects Dart/Flutter *_test.dart co-located with source", () => {
    // Paths NOT under a test/ directory, so only the `_test.dart` suffix rule can match.
    expect(isTestPath("lib/models/user_test.dart")).toBe(true);
    expect(isTestPath("lib/widgets/card_test.dart")).toBe(true);
    expect(isTestPath("lib/models/user.dart")).toBe(false); // source, not a test
    expect(isTestPath("lib/models/latest_config.dart")).toBe(false); // `_test` not at the stem boundary
  });

  it("detects JVM / C# / Swift class-suffix test conventions", () => {
    // Paths NOT under a test/ directory, so only the class-suffix rule can match.
    expect(isTestPath("app/src/main/java/WidgetTest.java")).toBe(true); // JUnit
    expect(isTestPath("app/UserServiceTests.kt")).toBe(true); // Kotlin
    expect(isTestPath("modules/pricing/PricingSpec.scala")).toBe(true); // ScalaTest
    expect(isTestPath("Services/OrderTests.cs")).toBe(true); // xUnit/NUnit
    expect(isTestPath("Sources/App/LoginTests.swift")).toBe(true); // XCTest
    expect(isTestPath("gradle/CartSpec.groovy")).toBe(true); // Spock
    expect(isTestPath("src/Service/UserTest.php")).toBe(true); // PHPUnit
    expect(isTestPath("app/Domain/PricingSpec.php")).toBe(true); // PHPSpec
    // Case-sensitive suffix: words merely ending in test/spec are not tests.
    expect(isTestPath("app/src/main/java/Latest.java")).toBe(false);
    expect(isTestPath("Services/Contest.cs")).toBe(false);
    expect(isTestPath("modules/manifest.scala")).toBe(false);
    expect(isTestPath("app/Latest.php")).toBe(false);
    // A non-JVM extension with the same class name is unaffected by this rule.
    expect(isTestPath("lib/WidgetTest.rb")).toBe(false);
  });

  it("does not treat framework or integration directory names alone as test evidence", () => {
    expect(isTestPath("src/integration/auth.ts")).toBe(false);
    expect(isTestPath("src/playwright/client.ts")).toBe(false);
    expect(isTestPath("src/cypress/client.ts")).toBe(false);
    expect(isTestPath("src/e2e/client.ts")).toBe(false);
    expect(isTestPath("src/integration/auth.test.ts")).toBe(true);
    expect(isTestPath("src/playwright/client.e2e.ts")).toBe(true);
    expect(isTestPath("src/cypress/client.cy.ts")).toBe(true);
  });

  it("treats explicit test file lists as evidence", () => {
    expect(hasLocalTestEvidence({ testFiles: ["internal/cache_test.go"] })).toBe(true);
    expect(hasLocalTestEvidence({ tests: [] })).toBe(false);
    expect(hasLocalTestEvidence({})).toBe(false);
  });

  it("detects PR-body validation notes used by review and manifest-policy gates", () => {
    expect(hasValidationNote("Validated with npm run test:ci and a smoke run.")).toBe(true);
    expect(hasValidationNote("Manual check passed for the dashboard.")).toBe(true);
    expect(hasValidationNote("Refactors the route naming only.")).toBe(false);
    expect(hasValidationNote("Adds retry logic to the fetch helper. Tested with npm run test:ci — all 142 tests pass.")).toBe(true);
  });

  // REGRESSION (#3304): a body that merely MENTIONS testing without affirming it was actually done must not
  // satisfy a configured manifest test expectation. Covers both negation-before-noun and noun-before-negation
  // word orders, since only guarding one direction still let the other slip through.
  it("rejects PR-body text that mentions tests/validation without affirming they passed", () => {
    expect(hasValidationNote("No tests run.")).toBe(false);
    expect(hasValidationNote("Tests not run.")).toBe(false);
    expect(hasValidationNote("I did not run tests for this change.")).toBe(false);
    expect(hasValidationNote("Tests were not run due to a broken CI runner.")).toBe(false);
    expect(hasValidationNote("Skipped tests for this one.")).toBe(false);
    expect(hasValidationNote("Tests failed locally but I'm opening this anyway.")).toBe(false);
    expect(hasValidationNote("No validation was performed.")).toBe(false);
  });

  // REGRESSION (#3304, round 2): the first negation fix used a literal `tests?` noun, which missed the past-
  // tense verb form "tested" -- "Not tested locally." slipped through as affirmative evidence because only
  // the (unrelated) positive "tested" keyword matched. The proximity-based redesign shares one stem
  // definition between the negation and affirmative checks, so this class of miss cannot recur for any
  // stem/tense combination.
  it("rejects negated verb forms the noun-only check missed, including compounds and interposed words", () => {
    expect(hasValidationNote("Not tested locally.")).toBe(false);
    expect(hasValidationNote("Untested change, opening as a draft-adjacent PR.")).toBe(false);
    expect(hasValidationNote("Unvalidated — please review carefully.")).toBe(false);
    expect(hasValidationNote("Testing skipped for this draft.")).toBe(false);
    expect(hasValidationNote("Have not run any tests yet.")).toBe(false);
  });

  // REGRESSION (#3304, round 2): a negation word elsewhere in the body must not suppress an unrelated,
  // later affirmative note -- the proximity check is bounded to the same sentence specifically so this
  // cannot happen (a prior naive "any negation word anywhere" design would wrongly return false here).
  it("does not let an unrelated negation elsewhere in the body suppress a real validation note", () => {
    expect(hasValidationNote("This is not a breaking change. Tested with npm run test:ci.")).toBe(true);
    expect(hasValidationNote("Not a big deal, tested with npm test.")).toBe(true);
  });

  // REGRESSION (#3304, round 3): the negation checks previously ran against the WHOLE body, so a genuine
  // negated clause ("No tests run locally.") vetoed the whole result even when a separate, later clause
  // provided real affirmative evidence -- discarding evidence the manifest gate is specifically trying to
  // detect. Each clause must now be judged independently.
  it("does not let an earlier genuine test-negation suppress later real affirmative evidence", () => {
    expect(hasValidationNote("No tests run locally. Validated with npm run test:ci.")).toBe(true);
    expect(hasValidationNote("Not tested on staging, but ran the full suite locally with npm test.")).toBe(true);
    expect(hasValidationNote("Skipped tests for the docs change. Verified the build output manually.")).toBe(true);
  });

  it("still rejects a body whose only test/validation mentions are all negated across clauses", () => {
    expect(hasValidationNote("No tests run. Not validated. Untested change.")).toBe(false);
  });

  // REGRESSION (#3304, round 4): a label-style status line glues its separator directly onto the stem
  // or negation word with no surrounding whitespace ("Tests: not run."). The proximity checks previously
  // required a literal space next to the stem/negation word, so the colon/semicolon/dash broke that
  // adjacency, the negation went undetected, and the bare "Tests"/"Validation" keyword fell through to
  // the affirmative check instead.
  it("detects a negation glued to the stem or negation word by a colon, semicolon, or dash", () => {
    expect(hasValidationNote("Tests: not run.")).toBe(false);
    expect(hasValidationNote("Validation: not run.")).toBe(false);
    expect(hasValidationNote("Tests: not run")).toBe(false);
    expect(hasValidationNote("Validation: Not Run.")).toBe(false);
    expect(hasValidationNote("Test: skipped.")).toBe(false);
    expect(hasValidationNote("Tests:not run.")).toBe(false);
    expect(hasValidationNote("Tests - not run.")).toBe(false);
    expect(hasValidationNote("Tests — not run.")).toBe(false); // em dash
    expect(hasValidationNote("Tests – not run.")).toBe(false); // en dash
    expect(hasValidationNote("Tests; not run.")).toBe(false);
    expect(hasValidationNote("Validation; not run.")).toBe(false);
    expect(hasValidationNote("Skipped: tests were not run.")).toBe(false); // negation word as the label
  });

  // REGRESSION (#3304, round 4): the label-separator gap must stay bounded to the junction touching the
  // stem/negation word -- it must not let a colon/semicolon/dash elsewhere in a longer sentence bridge a
  // negation across unrelated filler words, and a genuine colon/semicolon-glued negated clause still
  // must not suppress a separate, later real affirmative clause.
  it("does not let a label separator elsewhere in the sentence bridge an unrelated negation", () => {
    expect(hasValidationNote("No documentation issues; tests pass regardless.")).toBe(true);
    expect(hasValidationNote("Not sure if this fully works; tests pass regardless.")).toBe(true);
    expect(hasValidationNote("No changes needed here; validated with npm test.")).toBe(true);
    expect(hasValidationNote("Tests: not run. Validated with npm run test:ci.")).toBe(true);
    expect(hasValidationNote("Tests; not run. Validated with npm run test:ci.")).toBe(true);
  });
});

describe("classifyTestCoverage", () => {
  it("classifies an empty path list as absent", () => {
    expect(classifyTestCoverage([])).toBe("absent");
  });

  it("classifies a list with no test files as absent", () => {
    expect(classifyTestCoverage(["src/auth.ts", "src/utils.ts"])).toBe("absent");
  });

  it("classifies >= 40% test ratio as strong", () => {
    // 2 source + 2 test = 50%
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"])).toBe("strong");
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "e2e/a.spec.ts", "e2e/b.spec.ts"])).toBe("strong");
  });

  it("classifies 20%–39% test ratio as adequate", () => {
    // 3 source + 1 test = 25%
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"])).toBe("adequate");
  });

  it("classifies > 0% but < 20% test ratio as weak", () => {
    // 9 source + 1 test ≈ 10%
    const sources = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
    expect(classifyTestCoverage([...sources, "test/single.test.ts"])).toBe("weak");
  });
});

// #2187 (foundational slice of #1972): a bounded, deterministic framework/convention detector feeding the
// boundary-safe test-gen action spec (#2188).
describe("detectTestConvention", () => {
  it("detects vitest from its config marker, taking precedence over a stale jest config", () => {
    expect(detectTestConvention([], ["vitest.config.ts"])).toEqual({ framework: "vitest", testDir: "test/", namingPattern: "*.test.ts" });
    expect(detectTestConvention([], ["vitest.workspace.mts"])).toEqual({ framework: "vitest", testDir: "test/", namingPattern: "*.test.ts" });
    // A repo migrating off Jest keeps the old config around; vitest's own marker must still win (checked first).
    expect(detectTestConvention([], ["vitest.config.js", "jest.config.js"])).toEqual({ framework: "vitest", testDir: "test/", namingPattern: "*.test.ts" });
  });

  it("detects jest from its config marker", () => {
    expect(detectTestConvention([], ["jest.config.ts"])).toEqual({ framework: "jest", testDir: "__tests__/", namingPattern: "*.test.js" });
    expect(detectTestConvention([], ["jest.config.json"])).toEqual({ framework: "jest", testDir: "__tests__/", namingPattern: "*.test.js" });
  });

  it("detects pytest from pytest.ini or pyproject.toml", () => {
    expect(detectTestConvention([], ["pytest.ini"])).toEqual({ framework: "pytest", testDir: null, namingPattern: "test_*.py" });
    expect(detectTestConvention([], ["pyproject.toml"])).toEqual({ framework: "pytest", testDir: null, namingPattern: "test_*.py" });
  });

  it("detects go test from go.mod", () => {
    expect(detectTestConvention([], ["go.mod"])).toEqual({ framework: "go-test", testDir: null, namingPattern: "*_test.go" });
  });

  it("detects rspec from .rspec", () => {
    expect(detectTestConvention([], [".rspec"])).toEqual({ framework: "rspec", testDir: "spec/", namingPattern: "*_spec.rb" });
  });

  it("detects cargo test from Cargo.toml", () => {
    expect(detectTestConvention([], ["Cargo.toml"])).toEqual({ framework: "cargo-test", testDir: null, namingPattern: "#[cfg(test)] mod tests" });
  });

  it("matches a marker found in the changed paths, not only the markers list", () => {
    expect(detectTestConvention(["backend/go.mod", "backend/main.go"], [])).toEqual({ framework: "go-test", testDir: null, namingPattern: "*_test.go" });
  });

  it("falls back to inferring from an existing test file's naming when no marker is present", () => {
    expect(detectTestConvention(["test/unit/widget.test.ts"], [])).toEqual({ framework: "vitest", testDir: "test/", namingPattern: "*.test.ts" });
    expect(detectTestConvention(["__tests__/widget.test.js"], [])).toEqual({ framework: "jest", testDir: "__tests__/", namingPattern: "*.test.js" });
    expect(detectTestConvention(["mypackage/test_utils.py"], [])).toEqual({ framework: "pytest", testDir: null, namingPattern: "test_*.py" });
    expect(detectTestConvention(["pkg/foo_test.go"], [])).toEqual({ framework: "go-test", testDir: null, namingPattern: "*_test.go" });
    expect(detectTestConvention(["spec/models/widget_spec.rb"], [])).toEqual({ framework: "rspec", testDir: "spec/", namingPattern: "*_spec.rb" });
  });

  it("prefers a marker over an existing test file's naming when both are present", () => {
    // go.mod marker present alongside a Ruby-looking spec path (an unusual but possible polyglot repo) — the
    // marker is checked first and wins deterministically.
    expect(detectTestConvention(["spec/widget_spec.rb"], ["go.mod"])).toEqual({ framework: "go-test", testDir: null, namingPattern: "*_test.go" });
  });

  it("returns null for an unknown/empty layout (fail-safe)", () => {
    expect(detectTestConvention([], [])).toBeNull();
    expect(detectTestConvention(["src/widget.rs"], ["Makefile"])).toBeNull();
    // A path that merely LOOKS like a test file per isTestPath's directory rule, but whose extension isn't in
    // any known convention pattern (e.g. a bare snapshot), does not resolve to a framework.
    expect(detectTestConvention(["components/__snapshots__/Card.tsx.snap"], [])).toBeNull();
  });
});
