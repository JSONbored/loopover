// The typecheck-coverage checker must catch a workspace the root chain never reaches (#9860).
//
// The failure it guards is specific: `npm run typecheck` PASSING while part of the tree does not compile.
// That is worse than having no check, because the green result is trusted precisely because it is green --
// #9815 turned main red exactly that way. So the positive case here is "a declared typecheck nobody runs is
// reported", and the negative cases pin every legitimate way a workspace can be covered, since a checker
// that reports a covered workspace would be noise and would get muted.
import { describe, expect, it } from "vitest";

import { findTypecheckGaps } from "../../scripts/check-typecheck-coverage";

describe("findTypecheckGaps (#9860)", () => {
  it("REGRESSION: reports the exact #9815 shape — a UI workspace the root chain never invokes", () => {
    const scripts = {
      typecheck: "npm run typecheck:root && npm run typecheck:packages",
      "typecheck:root": "tsc --noEmit",
      "typecheck:packages": "tsc -p packages/loopover-contract/tsconfig.json --noEmit",
      // Present in the repo, but reachable only from test:ci -- never from `typecheck`.
      "ui:typecheck": "npm --workspace @loopover/ui run typecheck",
    };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "typecheck" },
    ]);
  });

  it("counts a workspace reached THROUGH an intermediate script as covered", () => {
    // The fix chains ui:typecheck into typecheck; the workspace is then covered transitively, not directly.
    const scripts = {
      typecheck: "npm run typecheck:root && npm run ui:typecheck",
      "typecheck:root": "tsc --noEmit",
      "ui:typecheck": "npm run ui:kit:build && npm --workspace @loopover/ui run typecheck",
      "ui:kit:build": "npm --workspace @loopover/ui-kit run build",
    };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([]);
  });

  it("counts a project typechecked directly by path as covered, without its own script being invoked", () => {
    // `typecheck:packages` runs tsc against the project file rather than calling the workspace's script.
    // Inputs must match what main() produces: { name, dir }, not a bare directory string (#10044).
    const scripts = {
      typecheck: "npm run typecheck:packages",
      "typecheck:packages": "tsc -p packages/loopover-contract/tsconfig.json --noEmit",
    };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/contract", dir: "packages/loopover-contract" }])).toEqual([]);
  });

  it("REGRESSION (#10044): a workspace covered ONLY by tsc -p <dir> is not reported when identified by scoped package name", () => {
    // Before the fix, covered held "packages/loopover-contract" while the filter only checked
    // "@loopover/contract" / "contract" — so the -p branch was dead for every real main() call.
    const scripts = {
      typecheck: "npm run typecheck:packages",
      "typecheck:packages": "tsc -p packages/loopover-contract/tsconfig.json --noEmit",
    };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/contract", dir: "packages/loopover-contract" }])).toEqual([]);
  });

  it("reports a gap when a different workspace's -p path does not cover this one", () => {
    const scripts = {
      typecheck: "npm run typecheck:packages",
      "typecheck:packages": "tsc -p packages/loopover-contract/tsconfig.json --noEmit",
    };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "typecheck" },
    ]);
  });

  it("handles the reversed flag order, since both spellings appear in this package.json", () => {
    const scripts = { typecheck: "npm run typecheck --workspace @loopover/ui" };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([]);
  });

  it("does NOT count a workspace whose BUILD is run but whose typecheck is not", () => {
    // A build may typecheck as a side effect, but that is a property of that script's current body, not a
    // guarantee. Treating it as coverage would silently accept a build that later stops emitting types.
    const scripts = { typecheck: "npm run ui:kit:build", "ui:kit:build": "npm --workspace @loopover/ui-kit run build" };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui-kit", dir: "packages/loopover-ui-kit" }])).toEqual([
      { workspace: "@loopover/ui-kit", script: "typecheck" },
    ]);
  });

  it("treats a workspace as covered when covered holds the unscoped name (scoped-name strip hit)", () => {
    // Reversed-flag form with an unscoped workspace token puts "ui" in covered; the filter must still
    // recognise @loopover/ui via name.replace(/^@[\w-]+\//, "").
    const scripts = { typecheck: "npm run typecheck --workspace ui" };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([]);
  });

  it("does not treat a workspace as covered via scoped-name strip when the unscoped token is absent", () => {
    // Body has no -p match and no workspace reference — strip fallback misses; gap is reported by name.
    const scripts = { typecheck: "tsc --noEmit" };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "typecheck" },
    ]);
  });

  it("terminates on a cyclic script graph instead of looping forever", () => {
    const scripts = { typecheck: "npm run a", a: "npm run b", b: "npm run a" };
    expect(findTypecheckGaps(scripts, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "typecheck" },
    ]);
  });

  it("reports nothing when no workspace declares a typecheck at all", () => {
    expect(findTypecheckGaps({ typecheck: "tsc --noEmit" }, [])).toEqual([]);
  });

  it("tolerates a missing entry script rather than throwing", () => {
    // A renamed root script must fail loudly as a REPORT, not as a crash mid-CI.
    expect(findTypecheckGaps({}, [{ name: "@loopover/ui", dir: "apps/loopover-ui" }])).toEqual([
      { workspace: "@loopover/ui", script: "typecheck" },
    ]);
  });
});
