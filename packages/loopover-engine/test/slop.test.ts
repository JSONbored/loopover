import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMissingTestEvidenceFinding, isTestableCodePath } from "../dist/index.js";

// #9696: isTestableCodePath is the single source-of-truth "code that ought to carry tests" predicate — a
// source file that is NOT mechanically-produced padding — and buildMissingTestEvidenceFinding filters on it,
// so a codegen-only diff never trips the missing-test-evidence signal.

test("isTestableCodePath is true for hand-authored source and false for padding or non-code", () => {
  assert.equal(isTestableCodePath("src/app/service.ts"), true);
  // Generated/vendored/minified output carries source extensions but is not hand-authored, so it is exempt.
  assert.equal(isTestableCodePath("api/service.pb.go"), false); // generated
  assert.equal(isTestableCodePath("vendor/dep/util.go"), false); // vendored
  assert.equal(isTestableCodePath("dist/app.min.js"), false); // minified
  assert.equal(isTestableCodePath("README.md"), false); // not a code file at all
});

test("buildMissingTestEvidenceFinding exempts a codegen-only diff but still fires on real code without tests", () => {
  // A diff of only generated output has no testable code → the missing-test-evidence signal must not fire.
  assert.equal(
    buildMissingTestEvidenceFinding({ changedFiles: [{ path: "api/service.pb.go", additions: 500, deletions: 0 }], tests: [], testFiles: [] }),
    null,
  );
  // Real hand-authored code with zero tests → the finding fires.
  const finding = buildMissingTestEvidenceFinding({ changedFiles: [{ path: "src/app/service.ts", additions: 120, deletions: 0 }], tests: [], testFiles: [] });
  assert.ok(finding && finding.code === "missing_test_evidence", "expected a missing-test-evidence finding for uncovered hand-authored code");
});
