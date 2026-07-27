import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  evaluateAndRecordHarnessSubmissionTrigger,
  countConsecutiveGateBlocks,
  prepareOpenPrSubmission,
  HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT,
} from "../../packages/loopover-miner/lib/harness-submission-trigger";
import { initEventLedger } from "../../packages/loopover-miner/lib/event-ledger";

const roots: string[] = [];
const closers: Array<{ close(): void }> = [];

function tempEventLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-harness-trigger-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "db.sqlite3"));
  closers.push(ledger);
  return ledger;
}

function passingVerdictFields() {
  return {
    predicted: true,
    basis: "public_config",
    pack: "oss-anti-slop",
    conclusion: "success",
    title: "t",
    summary: "s",
    readinessScore: 92,
    confirmedContributor: undefined,
    blockers: [],
    warnings: [],
    funnel: null,
    note: "",
  };
}

function handoffPacket(overrides: Record<string, unknown> = {}) {
  return {
    worktreePath: "/tmp/attempt-1",
    diffSummary: "added retry logic",
    selfReviewVerdict: {
      predictedGateVerdict: passingVerdictFields(),
      slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
      changedPaths: ["src/upload.ts"],
      passesPredictedGate: true,
    },
    attemptLogReference: "attempt-1",
    ...overrides,
  };
}

afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evaluateAndRecordHarnessSubmissionTrigger (#2337)", () => {
  it("full candidate -> gate-check -> submit cycle: a clean handoff allows and records one audit event", () => {
    const eventLedger = tempEventLedger();

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket(), slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision).toEqual({ allow: true, reasons: [], circuitBreakerTripped: false });
    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT);
    expect(events[0]?.payload).toMatchObject({ allow: true, circuitBreakerTripped: false, attemptLogReference: "attempt-1" });
  });

  it("kill-switch (#2339): blocks an otherwise-clean handoff unconditionally, and the block is recorded with the scope that caused it", () => {
    const eventLedger = tempEventLedger();

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "global", repoFullName: "acme/widgets", handoffPacket: handoffPacket(), slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision).toEqual({ allow: false, reasons: ["global_kill_switch_active"], circuitBreakerTripped: false });
    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    expect(events[0]?.payload).toMatchObject({ killSwitchScope: "global", allow: false });
  });

  it("full candidate -> gate-check -> correctly-blocked cycle: a non-passing handoff is blocked, and the block itself is recorded", () => {
    const eventLedger = tempEventLedger();
    const failingHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: { ...passingVerdictFields(), conclusion: "failure", blockers: [{ code: "duplicate_pr_risk", title: "t", detail: "d" }] },
        slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
        changedPaths: ["src/upload.ts"],
        passesPredictedGate: false,
      },
    });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: failingHandoff, slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.circuitBreakerTripped).toBe(false);
    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    expect(events[0]?.payload).toMatchObject({ allow: false });
  });

  it("circuit breaker: after enough consecutive blocked decisions this session, the run pauses even for an otherwise-clean handoff", () => {
    const eventLedger = tempEventLedger();
    const failingHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: { ...passingVerdictFields(), conclusion: "failure", blockers: [] },
        slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
        changedPaths: [],
        passesPredictedGate: false,
      },
    });

    // Three consecutive blocked decisions, each recorded to the real session history.
    for (let i = 0; i < 3; i += 1) {
      const blocked = evaluateAndRecordHarnessSubmissionTrigger(
        { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: failingHandoff, slopThreshold: "low", mode: "enforce", maxConsecutiveGateBlocks: 3 },
        { eventLedger },
      );
      expect(blocked.decision.allow).toBe(false);
    }
    expect(countConsecutiveGateBlocks(eventLedger, 0)).toBe(3);

    // A fourth candidate, this time a genuinely clean handoff -- the circuit breaker still pauses it.
    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket(), slopThreshold: "low", mode: "enforce", maxConsecutiveGateBlocks: 3 },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.circuitBreakerTripped).toBe(true);
    expect(result.decision.reasons).toEqual(["circuit_breaker_tripped_after_consecutive_blocks:3>=3"]);
  });

  it("a single allowed decision resets the consecutive-block streak, un-pausing the next candidate", () => {
    const eventLedger = tempEventLedger();
    const failingHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: { ...passingVerdictFields(), conclusion: "failure", blockers: [] },
        slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
        changedPaths: [],
        passesPredictedGate: false,
      },
    });

    evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: failingHandoff, slopThreshold: "low", mode: "enforce" }, { eventLedger });
    evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket(), slopThreshold: "low", mode: "enforce" }, { eventLedger });

    expect(countConsecutiveGateBlocks(eventLedger, 0)).toBe(0);
  });

  it("fail-closed: a null predictedGateVerdict (predictor unreachable) blocks, never treated as no-opinion-so-allow", () => {
    const eventLedger = tempEventLedger();
    const unreachableHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: null,
        slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
        changedPaths: [],
        passesPredictedGate: false,
      },
    });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: unreachableHandoff, slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toContain("predicted_gate_unavailable");
  });

  it("fail-closed: a null slopAssessment (slop check errored) blocks, never treated as no-opinion-so-allow", () => {
    const eventLedger = tempEventLedger();
    const erroredSlopHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: passingVerdictFields(),
        slopAssessment: null,
        changedPaths: [],
        passesPredictedGate: true,
      },
    });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: erroredSlopHandoff, slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toContain("slop_assessment_unavailable");
  });

  it("a handoff whose slop assessment exceeds the configured threshold is blocked, with the band/threshold pair in the reason", () => {
    const eventLedger = tempEventLedger();
    const highSlopHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: passingVerdictFields(),
        slopAssessment: { slopRisk: 0, band: "high", findings: [] },
        changedPaths: [],
        passesPredictedGate: true,
      },
    });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: highSlopHandoff, slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toEqual(["slop_band_exceeds_threshold:high>low"]);
  });

  it("observe mode: a would-have-allowed decision still forces allow: false, with a distinct reason from a would-have-blocked one", () => {
    const eventLedger = tempEventLedger();

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket(), slopThreshold: "low", mode: "observe" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toEqual(["observe_mode_active:would_have_allowed"]);
  });

  it("observe mode: a would-have-blocked decision is distinguishable from a would-have-allowed one, with the real reasons preserved", () => {
    const eventLedger = tempEventLedger();
    const failingHandoff = handoffPacket({
      selfReviewVerdict: {
        predictedGateVerdict: null,
        slopAssessment: { slopRisk: 0, band: "clean", findings: [] },
        changedPaths: [],
        passesPredictedGate: false,
      },
    });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: failingHandoff, slopThreshold: "low", mode: "observe" },
      { eventLedger },
    );

    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toEqual(["observe_mode_active:would_have_blocked", "predicted_gate_unavailable"]);
  });

  it("records a null attemptLogReference in the audit payload when the handoff packet omits one", () => {
    const eventLedger = tempEventLedger();
    const withoutReference = handoffPacket({ attemptLogReference: undefined });

    const result = evaluateAndRecordHarnessSubmissionTrigger(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: withoutReference, slopThreshold: "low", mode: "enforce" },
      { eventLedger },
    );

    expect(result.event.payload.attemptLogReference).toBeNull();
  });

  it("fails closed on a malformed candidate or missing dependency rather than silently allowing", () => {
    const eventLedger = tempEventLedger();
    expect(() => evaluateAndRecordHarnessSubmissionTrigger(null as never, { eventLedger })).toThrow("invalid_harness_submission_candidate");
    expect(() => evaluateAndRecordHarnessSubmissionTrigger({ repoFullName: "acme/widgets", handoffPacket: handoffPacket() } as never, { eventLedger })).toThrow(
      "invalid_kill_switch_scope",
    );
    expect(() =>
      evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "bogus", repoFullName: "acme/widgets", handoffPacket: handoffPacket() } as never, { eventLedger }),
    ).toThrow("invalid_kill_switch_scope");
    expect(() => evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", handoffPacket: handoffPacket() } as never, { eventLedger })).toThrow(
      "invalid_repo_full_name",
    );
    expect(() =>
      evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", repoFullName: "acme/widgets" } as never, { eventLedger }),
    ).toThrow("invalid_handoff_packet");
    expect(() =>
      evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket() } as never, null as never),
    ).toThrow("invalid_harness_submission_deps");
    expect(() =>
      evaluateAndRecordHarnessSubmissionTrigger({ killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket() } as never, {} as never),
    ).toThrow("invalid_event_ledger");
  });
});

describe("prepareOpenPrSubmission (#2337 open-pr call site)", () => {
  it("shapes a ready:true openPrInput exactly matching buildOpenPrSpec's expected fields when the gate allows", () => {
    const eventLedger = tempEventLedger();

    const result = prepareOpenPrSubmission(
      {
        killSwitchScope: "none",
        repoFullName: "acme/widgets",
        handoffPacket: handoffPacket({ branchRef: "attempt/1" }),
        slopThreshold: "low",
        mode: "enforce",
        base: "main",
        title: "fix: add retry logic",
        body: "Closes #1.",
        draft: true,
      },
      { eventLedger },
    );

    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready:true");
    expect(result.decision.allow).toBe(true);
    expect(result.openPrInput).toEqual({
      repoFullName: "acme/widgets",
      base: "main",
      head: "attempt/1",
      title: "fix: add retry logic",
      body: "Closes #1.",
      draft: true,
    });
  });

  it("returns ready:false (no openPrInput) when the gate blocks, without requiring a branch to open a PR from at all", () => {
    const eventLedger = tempEventLedger();

    // Kill-switch active AND no branchRef on the handoff -- proves the head-branch check never runs on the
    // blocked path (a candidate that will never open a PR must not throw for an unrelated missing-field reason).
    const result = prepareOpenPrSubmission(
      {
        killSwitchScope: "global",
        repoFullName: "acme/widgets",
        handoffPacket: handoffPacket(),
        slopThreshold: "low",
        mode: "enforce",
        base: "main",
        title: "fix: add retry logic",
      },
      { eventLedger },
    );

    expect(result.ready).toBe(false);
    expect(result.decision).toEqual({ allow: false, reasons: ["global_kill_switch_active"], circuitBreakerTripped: false });
    expect((result as { openPrInput?: unknown }).openPrInput).toBeUndefined();
  });

  it("throws invalid_pr_base on a missing/blank base, before any gate evaluation or ledger write", () => {
    const eventLedger = tempEventLedger();
    expect(() =>
      prepareOpenPrSubmission(
        { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket({ branchRef: "attempt/1" }), slopThreshold: "low", mode: "enforce", title: "t" } as never,
        { eventLedger },
      ),
    ).toThrow("invalid_pr_base");
    expect(() =>
      prepareOpenPrSubmission(
        { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket({ branchRef: "attempt/1" }), slopThreshold: "low", mode: "enforce", base: "   ", title: "t" },
        { eventLedger },
      ),
    ).toThrow("invalid_pr_base");
    expect(eventLedger.readEvents({})).toHaveLength(0); // failed before the wrapped gate call ever wrote an event
  });

  it("throws invalid_pr_title on a missing/blank title, before any gate evaluation or ledger write", () => {
    const eventLedger = tempEventLedger();
    expect(() =>
      prepareOpenPrSubmission(
        { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket({ branchRef: "attempt/1" }), slopThreshold: "low", mode: "enforce", base: "main" } as never,
        { eventLedger },
      ),
    ).toThrow("invalid_pr_title");
    expect(eventLedger.readEvents({})).toHaveLength(0);
  });

  it("throws invalid_pr_head_branch when the gate allows but the handoff packet has no branch to open a PR from -- the allow decision is still recorded to the ledger", () => {
    const eventLedger = tempEventLedger();

    expect(() =>
      prepareOpenPrSubmission(
        {
          killSwitchScope: "none",
          repoFullName: "acme/widgets",
          handoffPacket: handoffPacket(), // no branchRef
          slopThreshold: "low",
          mode: "enforce",
          base: "main",
          title: "t",
        },
        { eventLedger },
      ),
    ).toThrow("invalid_pr_head_branch");

    // The gate's own allow:true decision is still on the audit trail even though the spec-build step failed.
    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ allow: true });
  });

  it("defaults draft to false and body to an empty string when omitted", () => {
    const eventLedger = tempEventLedger();
    const result = prepareOpenPrSubmission(
      { killSwitchScope: "none", repoFullName: "acme/widgets", handoffPacket: handoffPacket({ branchRef: "attempt/1" }), slopThreshold: "low", mode: "enforce", base: "main", title: "t" },
      { eventLedger },
    );
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready:true");
    expect(result.openPrInput.draft).toBe(false);
    expect(result.openPrInput.body).toBe("");
  });

  it("trims repoFullName/base/title/head", () => {
    const eventLedger = tempEventLedger();
    const result = prepareOpenPrSubmission(
      {
        killSwitchScope: "none",
        repoFullName: " acme/widgets ",
        handoffPacket: handoffPacket({ branchRef: "  attempt/1  " }),
        slopThreshold: "low",
        mode: "enforce",
        base: "  main  ",
        title: "  t  ",
      },
      { eventLedger },
    );
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready:true");
    expect(result.openPrInput).toMatchObject({ repoFullName: "acme/widgets", base: "main", head: "attempt/1", title: "t" });
  });

  it("fails closed on a malformed candidate (null, or a non-object primitive) rather than silently allowing", () => {
    const eventLedger = tempEventLedger();
    expect(() => prepareOpenPrSubmission(null as never, { eventLedger })).toThrow("invalid_harness_submission_candidate");
    expect(() => prepareOpenPrSubmission("nope" as never, { eventLedger })).toThrow("invalid_harness_submission_candidate");
  });
});
