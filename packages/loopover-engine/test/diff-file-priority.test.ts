import { test } from "node:test";
import assert from "node:assert/strict";

import { diffFilePriority } from "../dist/review/diff-file-priority.js";
import { predictedGateEngineInternals } from "../dist/signals/predicted-gate-engine.js";

test("diffFilePriority: ranks lockfiles/generated output above test files above source", () => {
  assert.equal(diffFilePriority("package-lock.json"), 4);
  assert.equal(diffFilePriority("dist/bundle.js"), 4);
  assert.equal(diffFilePriority("src/app.test.ts"), 1);
  assert.equal(diffFilePriority("src/app.ts"), 0);
});

test("diffFilePriority: matches Cartfile.resolved, Carthage's real lockfile name (#4605 regression)", () => {
  // Carthage's actual lockfile is `Cartfile.resolved` — there is no `Cartfile.lock`. This engine-package
  // copy of diffFilePriority previously matched `cartfile\.lock` (a one-character-class typo), so a
  // touched Cartfile.resolved was ranked as SOURCE(0) here while the host copies
  // (src/review/review-diff.ts, src/review/review-grounding.ts) correctly ranked it lockfile(4) — silent
  // host/engine behavioral drift for Carthage/iOS repos that no drift check covered.
  assert.equal(diffFilePriority("Cartfile.resolved"), 4);
  assert.equal(diffFilePriority("ios/Cartfile.resolved"), 4);
  // `Cartfile.lock` is not a real Carthage filename — must NOT match.
  assert.equal(diffFilePriority("Cartfile.lock"), 0);
});

test("predictedGateEngineInternals.sharesMeaningfulFile: a shared Cartfile.resolved is not meaningful collision evidence (#4605)", () => {
  assert.equal(
    predictedGateEngineInternals.sharesMeaningfulFile(["Cartfile.resolved"], ["Cartfile.resolved"]),
    false,
  );
  assert.equal(predictedGateEngineInternals.sharesMeaningfulFile(["src/app.ts"], ["src/app.ts"]), true);
});

test("diffFilePriority: ranks every vendored-directory name path-matchers.ts's isVendoredFileFrom recognizes (#7526)", () => {
  assert.equal(diffFilePriority("vendor/x.js"), 4);
  assert.equal(diffFilePriority("vendored/x.js"), 4);
  assert.equal(diffFilePriority("third_party/x.js"), 4);
  assert.equal(diffFilePriority("third-party/x.js"), 4);
  assert.equal(diffFilePriority("bower_components/x.js"), 4);
  assert.equal(diffFilePriority("jspm_packages/x.js"), 4);
});

test("predictedGateEngineInternals.sharesMeaningfulFile: a file shared only under a vendored directory is not meaningful collision evidence (#7526)", () => {
  assert.equal(
    predictedGateEngineInternals.sharesMeaningfulFile(["third_party/lib.js"], ["third_party/lib.js"]),
    false,
  );
  assert.equal(
    predictedGateEngineInternals.sharesMeaningfulFile(["bower_components/lib.js"], ["bower_components/lib.js"]),
    false,
  );
});
