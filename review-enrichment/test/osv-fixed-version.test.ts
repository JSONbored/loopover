// Units for the OSV "fixed in X" remediation version reported by the dependency-scan and lockfile-drift
// analyzers. Own file so concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedOf as fixedOfLockfile } from "../dist/analyzers/lockfile-drift.js";
import { fixedOf as fixedOfDependency } from "../dist/analyzers/dependency-scan.js";

// The bug fix is identical in both analyzers, so assert the same contract against each exported helper.
for (const [name, fixedOf] of [
  ["lockfile-drift", fixedOfLockfile],
  ["dependency-scan", fixedOfDependency],
] as const) {
  test(`${name} fixedOf: reports a single unambiguous fix, null when a CVE lists multiple version-line fixes`, () => {
    // One affected range with one fix → report it (the common single-line CVE).
    assert.equal(fixedOf({ id: "GHSA-1", affected: [{ ranges: [{ events: [{ fixed: "1.5.0" }] }] }] }), "1.5.0");
    // The SAME fixed version appearing in two ranges is still unambiguous → report it.
    assert.equal(
      fixedOf({ id: "GHSA-2", affected: [{ ranges: [{ events: [{ fixed: "2.3.0" }] }] }, { ranges: [{ events: [{ fixed: "2.3.0" }] }] }] }),
      "2.3.0",
    );
    // Two DIFFERENT fixes across version lines (a CVE patched separately per major) → ambiguous → null, NOT the
    // first fix "1.5.0" (which would tell a 2.x user to downgrade to a version that doesn't fix their line).
    assert.equal(
      fixedOf({ id: "GHSA-3", affected: [{ ranges: [{ events: [{ fixed: "1.5.0" }] }] }, { ranges: [{ events: [{ fixed: "2.3.0" }] }] }] }),
      null,
    );
    // No fix advertised → null.
    assert.equal(fixedOf({ id: "GHSA-4", affected: [{ ranges: [{ events: [{}] }] }] }), null);
    // Empty / missing affected → null.
    assert.equal(fixedOf({ id: "GHSA-5" }), null);
  });
}
