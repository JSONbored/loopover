import { describe, expect, it } from "vitest";

import { MERGE_HOLD_INPUT_KEYS, derivePrDisposition, type PrDispositionInput } from "../../src/settings/pr-disposition";
import { persistDecisionRecord } from "../../src/review/decision-record";
import { createTestEnv } from "../helpers/d1";

// #9991: WHY a pull request was held, recorded.
//
// The ledger filed 518 holds across 146 pull requests under `reason_code = "success"` -- not a reason, but
// deriveDecisionReasonCode falling through to the gate conclusion when there is no blocker and no policy
// close. #9729 cannot run a per-path backtest clearance against a bucket conflating seven mechanisms.
//
// The constraint that shaped the fix: `reason_code` MUST NOT change. replayDecision recomputes it and reports
// a divergence on mismatch, so a new derivation would make all 518 existing records replay as unreproducible
// -- a false "cannot be re-derived" about records that are fine. The cause therefore lands in its own column,
// outside record_json, leaving digests and the replay contract untouched.

const baseInput = (over: Partial<PrDispositionInput> = {}): PrDispositionInput => ({
  mergeableState: "clean",
  reviewGood: true,
  guardrailHit: false,
  migrationCollisionHold: false,
  unlinkedIssueMatchHold: false,
  advisoryCheckHold: false,
  priorityEligibilityHold: false,
  screenshotEvidenceHold: false,
  unlinkedIssueMatchCloseWithoutCloseActing: false,
  ...over,
});

describe("derivePrDisposition heldBy (#9991)", () => {
  it("names the input that held, not merely that something did", () => {
    expect(derivePrDisposition(baseInput({ guardrailHit: true })).heldBy).toEqual(["guardrailHit"]);
  });

  it("names every input that held, in the table's declaration order", () => {
    // Declaration order, not input order, so the recorded cause is deterministic for identical inputs.
    const held = derivePrDisposition(baseInput({ screenshotEvidenceHold: true, guardrailHit: true })).heldBy;
    expect(held).toEqual(["guardrailHit", "screenshotEvidenceHold"]);
    expect(held.indexOf("guardrailHit")).toBeLessThan(held.indexOf("screenshotEvidenceHold"));
  });

  it("is empty when nothing held", () => {
    const disposition = derivePrDisposition(baseInput());
    expect(disposition.heldBy).toEqual([]);
    expect(disposition.heldForManualReview).toBe(false);
  });

  it("REGRESSION: excludes a RELEASED hold, matching heldForManualReview exactly", () => {
    // #9808: a guardrail hit cleared by a clean escalated review no longer holds. Recording it as the cause
    // would name a hold that did not happen.
    const disposition = derivePrDisposition(baseInput({ guardrailHit: true, guardrailEscalationCleared: true }));
    expect(disposition.heldBy).toEqual([]);
    expect(disposition.heldForManualReview).toBe(false);
  });

  it("INVARIANT: heldForManualReview is true whenever heldBy is non-empty, for every declared input", () => {
    // The two must never disagree -- heldForManualReview is now derived FROM heldBy, and this pins that for
    // each key in the table rather than for one sampled case.
    for (const key of MERGE_HOLD_INPUT_KEYS) {
      const disposition = derivePrDisposition(baseInput({ [key]: true } as Partial<PrDispositionInput>));
      expect(disposition.heldBy, key).toEqual([key]);
      expect(disposition.heldForManualReview, key).toBe(true);
    }
  });

  it("stays empty when only the unstable mergeable state suppresses the merge", () => {
    // That is GitHub's computation, not one of our declared inputs, and is reported separately.
    const disposition = derivePrDisposition(baseInput({ mergeableState: "unstable" }));
    expect(disposition.heldBy).toEqual([]);
    expect(disposition.heldForUnstableMergeState).toBe(true);
    expect(disposition.heldForManualReview).toBe(true);
  });
});

describe("persistDecisionRecord hold_cause (#9991)", () => {
  const record = {
    schemaVersion: 1 as const,
    repoFullName: "acme/widgets",
    pullNumber: 7,
    headSha: "a".repeat(40),
    baseSha: null,
    action: "hold",
    reasonCode: "success",
    decidedAt: "2026-07-31T12:00:00.000Z",
  };

  async function holdCauseFor(env: Env, cause?: string | null): Promise<string | null> {
    await persistDecisionRecord(env, record as never, "d".repeat(64), 3, undefined, cause);
    const row = await env.DB.prepare(`SELECT hold_cause FROM decision_records WHERE pull_number = 7`).first<{ hold_cause: string | null }>();
    return row?.hold_cause ?? null;
  }

  it("writes the cause alongside the record", async () => {
    expect(await holdCauseFor(createTestEnv(), "guardrailHit,screenshotEvidenceHold")).toBe("guardrailHit,screenshotEvidenceHold");
  });

  it("writes NULL when no declared input held, rather than an empty string", async () => {
    // Null and "" would both read as falsy in code but differently in SQL; one value for "no cause".
    expect(await holdCauseFor(createTestEnv(), null)).toBeNull();
    expect(await holdCauseFor(createTestEnv())).toBeNull();
  });

  it("REGRESSION: the cause does NOT enter record_json, so digests and replay are untouched", async () => {
    // The whole reason this is a column. record_json is what recordDigest commits to and what replayDecision
    // re-derives; a field in there would move every future digest and drag a private value into a published
    // commitment.
    const env = createTestEnv();
    await persistDecisionRecord(env, record as never, "d".repeat(64), 3, undefined, "guardrailHit");
    const row = await env.DB.prepare(`SELECT record_json, reason_code FROM decision_records WHERE pull_number = 7`).first<{ record_json: string; reason_code: string }>();
    expect(row?.record_json).not.toContain("guardrailHit");
    expect(row?.record_json).not.toContain("hold_cause");
    // And reason_code is untouched, which is what keeps the 518 historical records replayable.
    expect(row?.reason_code).toBe("success");
  });
});
