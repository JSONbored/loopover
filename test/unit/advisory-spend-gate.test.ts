import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advisorySpendStopReason } from "../../src/queue/advisory-spend-gate";

// #9541 (deliverable 2) / #9491: three features each make a paid LLM call per PR head, each grew its own
// hand-written guard line, and they drifted — the linked-issue advisory was the one member of the family with
// NO per-PR commit cap, so a long-lived PR kept paying on every push after its siblings had stopped. Nobody
// could have caught that by reading one function: the guards lived in three files and the incomplete one
// looked complete on its own.
describe("advisorySpendStopReason (#9541)", () => {
  const proceed = { mode: "live" as const, headSha: "abc123", commitThresholdReached: false };

  it("returns null when every universal precondition passes", () => {
    expect(advisorySpendStopReason(proceed)).toBeNull();
  });

  it("REGRESSION: stops on the per-PR commit cap — the stop the linked-issue advisory shipped without", () => {
    expect(advisorySpendStopReason({ ...proceed, commitThresholdReached: true })).toBe("commit_threshold_reached");
  });

  it("stops a paused repo, independent of the feature's own mode setting", () => {
    expect(advisorySpendStopReason({ ...proceed, mode: "paused" })).toBe("paused");
  });

  it("stops when there is no head SHA to attribute the spend to", () => {
    for (const headSha of [null, undefined, ""]) {
      expect(advisorySpendStopReason({ ...proceed, headSha }), String(headSha)).toBe("no_head_sha");
    }
  });

  it("INVARIANT: precedence is paused → no_head_sha → commit cap, matching the hand-written guards it replaces", () => {
    // Order is load-bearing, not cosmetic: adopting this function had to be behaviour-preserving, and the
    // reason a given PR reports decides which audit event it emits. A re-ordering would silently relabel
    // real production history.
    expect(advisorySpendStopReason({ mode: "paused", headSha: null, commitThresholdReached: true })).toBe("paused");
    expect(advisorySpendStopReason({ mode: "live", headSha: null, commitThresholdReached: true })).toBe("no_head_sha");
  });

  it("is PURE — same input, same answer, and the input is never mutated", () => {
    const input = { ...proceed, commitThresholdReached: true };
    const snapshot = JSON.stringify(input);
    expect(advisorySpendStopReason(input)).toBe(advisorySpendStopReason(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  // The point of the module is that a FOURTH advisory cannot be written without these stops. That only holds
  // while the existing three actually route through it, so the adoption itself is pinned at the source —
  // the same producer-drift-guard convention db-parsers.test.ts uses for STALE_RECHECK_DENIAL_DETAIL_PATTERN.
  describe("adoption is real, not aspirational", () => {
    it.each([
      ["src/queue/slop-detection.ts", "runAiSlopForAdvisory"],
      ["src/queue/processors.ts", "runLinkedIssueSatisfactionForAdvisory"],
    ])("%s routes its paid advisory through the shared gate", (file) => {
      expect(readFileSync(file, "utf8")).toContain("advisorySpendStopReason(");
    });

    it("neither adopter re-implements the commit-cap stop inline, which is what allowed the two to disagree", () => {
      for (const file of ["src/queue/slop-detection.ts", "src/queue/processors.ts"]) {
        const source = readFileSync(file, "utf8");
        expect(source, file).not.toContain("if (args.commitThresholdReached) return");
      }
    });

    it("INVARIANT: the author rule is deliberately NOT unified — ai_review reviews some unconfirmed authors", () => {
      // Folding `confirmedContributor` in would either narrow ai_review's audience or widen the other two's.
      // A 'shared' rule that is wrong for one caller is how the next #9491 gets written, so the module must
      // keep saying so and must not grow the field.
      const gate = readFileSync("src/queue/advisory-spend-gate.ts", "utf8");
      expect(gate).not.toContain("confirmedContributor:");
      expect(gate).toContain("resolveAiReviewableAuthor");
    });
  });
});
