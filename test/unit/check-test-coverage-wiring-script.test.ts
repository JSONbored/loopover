// The test-wiring checker must catch a workspace `test:ci` never reaches (#10049).
//
// The failure it guards is specific: a workspace declares its own `test` script and nothing in the root
// `test:ci` chain ever invokes it, so the suite sits there -- written, reviewed, never executed -- while
// everything ELSE (build, pack, lint, typecheck) stays green. #10049 found exactly this for
// @loopover/ui-kit's 12-file vitest suite. So the positive case here is "a declared test nobody runs is
// reported", and the negative cases pin every legitimate way a workspace can be covered, since a checker
// that reports a covered workspace would be noise and would get muted.
import { describe, expect, it } from "vitest";

import { findTestWiringGaps } from "../../scripts/check-test-coverage-wiring";

describe("findTestWiringGaps (#10049)", () => {
  it("REGRESSION: reports the exact #10049 shape — ui-kit's test script the root chain never invokes", () => {
    const scripts = {
      "test:ci": "npm run ui:lint && npm run ui:typecheck && npm run ui:test",
      "ui:lint": "npm run ui:kit:build && npm --workspace @loopover/ui-kit run format:check",
      "ui:typecheck": "npm run ui:kit:build && npm --workspace @loopover/ui-kit run typecheck",
      // Present in the repo, but only ever builds ui-kit -- never runs its test script.
      "ui:test": "npm run ui:kit:build && npm --workspace @loopover/ui run test && npm --workspace @loopover/ui-miner run test",
      "ui:kit:build": "npm run build --workspace @loopover/ui-kit",
    };
    expect(
      findTestWiringGaps(scripts, [
        { name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" },
        { name: "@loopover/ui", dir: "apps/loopover-ui" },
      ]),
    ).toEqual([{ workspace: "@loopover/ui-kit", script: "test" }]);
  });

  it("counts a workspace reached THROUGH an intermediate script as covered", () => {
    // The fix chains ui-kit's test into ui:test; the workspace is then covered transitively.
    const scripts = {
      "test:ci": "npm run ui:test",
      "ui:test": "npm run ui:kit:build && npm --workspace @loopover/ui-kit run test && npm --workspace @loopover/ui run test",
      "ui:kit:build": "npm run build --workspace @loopover/ui-kit",
    };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([]);
  });

  it("reports a workspace whose BUILD is invoked but whose test is not", () => {
    // A build may exercise some code as a side effect, but that is not a guarantee the test script runs.
    const scripts = { "test:ci": "npm run ui:kit:build", "ui:kit:build": "npm run build --workspace @loopover/ui-kit" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("handles the reversed flag order, since both spellings appear in this package.json", () => {
    const scripts = { "test:ci": "npm run test --workspace @loopover/engine" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/engine", dir: "packages/loopover-engine" }])).toEqual([]);
  });

  it("does NOT count a non-test script invoked via --workspace as coverage", () => {
    const scripts = { "test:ci": "npm --workspace @loopover/ui-kit run build" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("does NOT count a non-test script invoked via the reversed --workspace flag order", () => {
    const scripts = { "test:ci": "npm run build --workspace @loopover/ui-kit" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("treats a workspace as covered when covered holds the unscoped name (scoped-name strip hit)", () => {
    const scripts = { "test:ci": "npm run test --workspace ui-kit" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([]);
  });

  it("does not treat a workspace as covered via scoped-name strip when the unscoped token is absent", () => {
    const scripts = { "test:ci": "echo noop" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("terminates on a cyclic script graph instead of looping forever", () => {
    const scripts = { "test:ci": "npm run a", a: "npm run b", b: "npm run a" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("reports nothing when no workspace declares a test at all", () => {
    expect(findTestWiringGaps({ "test:ci": "echo noop" }, [])).toEqual([]);
  });

  it("tolerates a missing entry script rather than throwing", () => {
    // A renamed root script must fail loudly as a REPORT, not as a crash mid-CI.
    expect(findTestWiringGaps({}, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("treats a workspace as covered when covered holds its directory path (npm --workspace <path> form)", () => {
    const scripts = { "test:ci": "npm --workspace packages/loopover-ui-kit run test" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([]);
  });

  it("accepts an explicit entry point other than the test:ci default", () => {
    const scripts = { "ui:test": "npm --workspace @loopover/ui-kit run test" };
    expect(
      findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }], "ui:test"),
    ).toEqual([]);
  });
});
