// The test-coverage-wiring checker must catch a workspace the root test:ci chain never reaches (#10049).
//
// The failure it guards is specific: a workspace declares `"test"` and nothing in test:ci invokes it, so
// the suite can never fail CI. That is worse than having no suite, because green results around it are
// trusted. Mirror of check-typecheck-coverage-script.test.ts for the test / test:ci pair.
import { describe, expect, it } from "vitest";

import { findTestWiringGaps } from "../../scripts/check-test-coverage-wiring";

describe("findTestWiringGaps (#10049)", () => {
  it("reports a workspace reached by nobody — the ui-kit shape", () => {
    const scripts = {
      "test:ci": "npm run test --workspace @loopover/engine && npm run ui:test",
      "ui:test": "npm run ui:kit:build && npm --workspace @loopover/ui run test && npm --workspace @loopover/ui-miner run test",
      "ui:kit:build": "npm --workspace @loopover/ui-kit run build",
    };
    expect(
      findTestWiringGaps(scripts, [
        { name: "@loopover/ui", dir: "apps/loopover-ui" },
        { name: "@loopover/ui-miner", dir: "apps/loopover-miner-ui" },
        { name: "@loopover/engine", dir: "packages/loopover-engine" },
        { name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" },
      ]),
    ).toEqual([{ workspace: "@loopover/ui-kit", script: "test" }]);
  });

  it("counts a workspace reached directly as covered", () => {
    const scripts = {
      "test:ci": "npm run test --workspace @loopover/engine",
    };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/engine", dir: "packages/loopover-engine" }])).toEqual([]);
  });

  it("counts a workspace reached THROUGH an intermediate script as covered", () => {
    const scripts = {
      "test:ci": "npm run ui:test",
      "ui:test": "npm run ui:kit:build && npm --workspace @loopover/ui-kit run test",
      "ui:kit:build": "npm --workspace @loopover/ui-kit run build",
    };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([]);
  });

  it("does NOT count a workspace whose BUILD is run but whose test is not", () => {
    const scripts = {
      "test:ci": "npm run ui:kit:build",
      "ui:kit:build": "npm --workspace @loopover/ui-kit run build",
    };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "test" },
    ]);
  });

  it("handles the reversed flag order, since both spellings appear in this package.json", () => {
    const scripts = { "test:ci": "npm run test --workspace @loopover/ui" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([]);
  });

  it("terminates on a cyclic script graph instead of looping forever", () => {
    const scripts = { "test:ci": "npm run a", a: "npm run b", b: "npm run a" };
    expect(findTestWiringGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "test" },
    ]);
  });

  it("tolerates a missing entry script rather than throwing", () => {
    expect(findTestWiringGaps({}, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "test" },
    ]);
  });

  it("reports nothing when no workspace declares a test at all", () => {
    expect(findTestWiringGaps({ "test:ci": "echo ok" }, [])).toEqual([]);
  });
});
