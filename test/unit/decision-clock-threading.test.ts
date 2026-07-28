import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #9492 parity guard for the decision-clock threading, in the same spirit as db-parsers.test.ts's
// STALE_RECHECK_DENIAL_DETAIL_PATTERN producer-drift guard: the two remaining sites live inside
// `buildAgentMaintenancePlanInput` / `runAgentMaintenancePlanAndExecute`, neither of which is exported, so
// there is no seam to drive them through. Reading the producer source is the honest alternative to either
// exporting internals purely for a test, or leaving the regression unguarded.
//
// What this protects: #9028/#9256 shipped "replayable time" — ONE `Date.now()` per decision pass, recorded
// into the replay input. The value of that is entirely destroyed by a SECOND, unrecorded clock read in the
// same pass, because the recorded instant then is not the instant that decided. Worse, `replayDecision` pins
// `action` and only re-derives `evaluateGateCheck`, so replaying a decision made on an unrecorded read
// reports `verdict: "match"` — a FALSE CERTIFICATION rather than a caught divergence.
describe("decision-clock threading in the maintenance pass (#9492)", () => {
  const source = () => readFileSync("src/queue/processors.ts", "utf8");

  it("REGRESSION: the merge-blocked read uses the pass's recorded instant, never a fresh Date.now()", () => {
    const text = source();
    expect(text).toContain("activeMergeBlockedSha(pr, pr.headSha, args.decisionNowMs)");
    expect(text).not.toContain("activeMergeBlockedSha(pr, pr.headSha, Date.now())");
  });

  it("INVARIANT: decisionNowMs is a REQUIRED plan-input field, so a new call site cannot silently omit it", () => {
    // Optionality is how this class of context field drifts (the #9482 lesson) — an optional clock would let
    // a future caller reintroduce the gap by simply not passing it, with no type error.
    expect(source()).toContain("decisionNowMs: number;");
    expect(source()).not.toMatch(/decisionNowMs\?\s*:/);
  });

  it("REGRESSION: the account-age derivation uses the recorded instant — it decides isNewAccount, which halves the contributor cap", () => {
    const text = source();
    expect(text).toContain("const ageDays = (decisionClock.nowMs - Date.parse(createdAt))");
    expect(text).not.toContain("const ageDays = (Date.now() - Date.parse(createdAt))");
  });

  it("REGRESSION: the unlinked-issue guardrail is called with the recorded instant — its velocity gap chooses CLOSE vs HOLD", () => {
    expect(source()).toContain("nowMs: decisionClock.nowMs,");
  });

  it("INVARIANT: the pass still captures exactly ONE clock instant to thread", () => {
    // The whole mechanism rests on there being a single captured instant; two captures would be the same bug
    // wearing a different shape.
    const captures = source().match(/const decisionClock: DecisionClockCapture = \{ nowMs: Date\.now\(\) \}/g) ?? [];
    expect(captures).toHaveLength(1);
  });

  it("INVARIANT: decision-replay's honest-scope note names the reads deliberately left on the live clock", () => {
    // The note must stay accurate: a scope claim that silently widens is worse than a narrow one, because a
    // reader trusts it. Pins that each still-live class is actually named.
    const replaySource = readFileSync("src/review/decision-replay.ts", "utf8");
    expect(replaySource).toContain("isBelowAccountAgeThreshold");
    expect(replaySource).toContain("submitter-reputation.ts");
  });
});
