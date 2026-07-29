import { describe, expect, it, vi } from "vitest";
import { claimTransientLock } from "../../src/queue/transient-locks";
import { maybeAddReputationSkipHold, maybeAddRequiredAutoReviewSkipHold } from "../../src/queue/processors";
import { AGENT_LABEL_NEEDS_REVIEW, planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
import type { GateCheckConclusion } from "../../src/rules/advisory";
import { createTestEnv } from "../helpers/d1";

// #9063: three cross-surface invariant tests targeting the "absence"/"reachability"/"cross-path parity" defect
// classes the 99%-coverage gate structurally cannot see (every assertion below is about a branch that emits
// NOTHING, a state that can be entered but never left, or two paths that must agree -- not about a forward
// path a normal unit test already walks). Modeled on test/unit/pr-disposition-invariants.test.ts: sweep the
// state space with a loop rather than hand-picking one scenario, so a regression anywhere in the swept range
// fails here even if the specific case a narrative test picked still happens to pass.

describe("AI-review lock claim outcomes are exhaustive and traceable (#9008, absence)", () => {
  it("acquisition is fully determined by {contested, steal} -- steal eliminates the silent-contended branch instead of leaving it reachable", async () => {
    for (const steal of [false, true]) {
      const env = createTestEnv();
      const key = `ai-review-lock:steal=${steal}`;

      const uncontested = await claimTransientLock(env, key, 60);
      expect(uncontested.acquired, `steal=${steal} uncontested`).toBe(true);

      // A second, non-steal claim against the SAME still-live key: this is the branch that used to be
      // reachable for a forced retrigger too (#9008) -- a caller landing here with no distinguishing signal
      // is exactly the "silent" shape #9063 warns about. Confirm it is still correctly contended...
      const contendedNonSteal = await claimTransientLock(env, key, 60);
      expect(contendedNonSteal.acquired, `steal=${steal} contended non-steal probe`).toBe(false);

      // ...then confirm `steal` makes the outcome for THIS call deterministic and distinct: a forced caller
      // never lands on "acquired: false" (the fix), while a non-forced caller never silently succeeds either.
      const outcome = await claimTransientLock(env, key, 60, { steal });
      expect(outcome.acquired, `steal=${steal} final outcome`).toBe(steal ? true : false);
    }
  });

  it("an EXPIRED lock recovers WITHOUT steal -- orphaned-lock recovery, unrepresentable before #9063's TTL fix to the transient-cache test double", async () => {
    vi.useFakeTimers();
    try {
      const env = createTestEnv();
      const key = "ai-review-lock:orphan-recovery";

      const original = await claimTransientLock(env, key, 30);
      expect(original.acquired).toBe(true);

      const stillLive = await claimTransientLock(env, key, 30);
      expect(stillLive.acquired).toBe(false); // TTL not yet elapsed -- genuinely contended

      vi.advanceTimersByTime(31_000); // past the 30s TTL: the process that held this lock is presumed dead

      const afterExpiry = await claimTransientLock(env, key, 30); // ordinary claim -- NOT steal
      expect(afterExpiry.acquired).toBe(true); // recovers on its own; no forced retrigger needed
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manual-review lock-contention auto-clear is reachable exactly once, never alongside another live hold (#9009, reachability)", () => {
  const basePlanInput = {
    blockerTitles: [] as string[],
    changedPaths: [] as string[],
    hardGuardrailGlobs: [] as string[],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    autonomy: { approve: "auto", merge: "auto", review_state_label: "auto", close: "auto" } as const,
    autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } as const,
    slopGateMinScore: 60,
    ciState: "passed" as const,
  };

  // Four independent, real causes of `manualHoldReason !== null` (src/settings/agent-actions.ts ~1160): a
  // regression that re-adds a fifth one without also excluding it from the auto-clear branch would only be
  // caught by sweeping several causes, not by re-checking the one the original #9009 fix happened to cite.
  const otherLiveHolds: Array<[string, Partial<AgentActionPlanInput> & { conclusion: GateCheckConclusion }]> = [
    ["a hard-guardrail path hit", { conclusion: "success", changedPaths: ["src/settings/agent-actions.ts"], hardGuardrailGlobs: ["src/settings/**"] }],
    ["CI could not be verified", { conclusion: "success", ciState: "unverified" }],
    ["the gate requires maintainer action", { conclusion: "action_required" }],
    ["a not-review-good verdict with no close in flight", { conclusion: "neutral" }],
  ];

  for (const [label, over] of otherLiveHolds) {
    it(`does NOT remove manual-review when ${label} is ALSO live this pass, even with the lock-contention marker resolved`, () => {
      const plan = planAgentMaintenanceActions({
        ...basePlanInput,
        pr: { labels: [AGENT_LABEL_NEEDS_REVIEW], mergeableState: "clean" },
        manualReviewLockContentionResolved: true,
        ...over,
      });
      expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "remove")).toBe(false);
    });
  }

  it("DOES remove once nothing else is live -- the reachable control case the four exclusions above are measured against", () => {
    const plan = planAgentMaintenanceActions({
      ...basePlanInput,
      conclusion: "success",
      pr: { labels: [AGENT_LABEL_NEEDS_REVIEW], mergeableState: "clean" },
      manualReviewLockContentionResolved: true,
    });
    expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "remove" }));
  });
});

describe("reputation-triggered and contributor-controlled AI-review skips hold in lockstep (#9015, cross-path parity)", () => {
  const modes = ["block", "advisory", "off"] as const;
  const advisoryStub = () => ({ headSha: "sha", findings: [] as Array<{ code: string }> });
  const envFor = () => ({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI: {} }) as Env;

  it("for every aiReviewMode: a skip holds BOTH siblings identically, or NEITHER -- never one without the other", () => {
    for (const aiReviewMode of modes) {
      const settings = { gatePack: "oss-anti-slop", aiReviewMode, aiReviewAllAuthors: false } as never;
      const env = envFor();

      const contributorAdvisory = advisoryStub();
      const contributorHeld = maybeAddRequiredAutoReviewSkipHold(env, {
        mode: "live",
        settings,
        advisory: contributorAdvisory as never,
        repoFullName: "acme/widgets",
        author: "alice",
        confirmedContributor: false,
        autoReviewSkipReason: "review skipped (WIP title)",
      });

      const reputationAdvisory = advisoryStub();
      const reputationHeld = maybeAddReputationSkipHold(env, {
        mode: "live",
        settings,
        advisory: reputationAdvisory as never,
        repoFullName: "acme/widgets",
        author: "burst-farmer",
        confirmedContributor: false,
        reputationSkipped: true,
      });

      expect(reputationHeld, `mode=${aiReviewMode}`).toBe(contributorHeld);
      expect(reputationAdvisory.findings.length, `mode=${aiReviewMode}`).toBe(contributorAdvisory.findings.length);
      if (contributorHeld) {
        expect(contributorAdvisory.findings[0]).toMatchObject({ code: "ai_review_inconclusive" });
        expect(reputationAdvisory.findings[0]).toMatchObject({ code: "ai_review_inconclusive" });
      }
    }
  });

  it("for every aiReviewMode: neither sibling holds when its OWN skip condition is false", () => {
    for (const aiReviewMode of modes) {
      const settings = { gatePack: "oss-anti-slop", aiReviewMode, aiReviewAllAuthors: false } as never;
      const env = envFor();

      const contributorAdvisory = advisoryStub();
      expect(
        maybeAddRequiredAutoReviewSkipHold(env, {
          mode: "live",
          settings,
          advisory: contributorAdvisory as never,
          repoFullName: "acme/widgets",
          author: "alice",
          confirmedContributor: false,
          autoReviewSkipReason: null,
        }),
        `mode=${aiReviewMode}`,
      ).toBe(false);

      const reputationAdvisory = advisoryStub();
      expect(
        maybeAddReputationSkipHold(env, {
          mode: "live",
          settings,
          advisory: reputationAdvisory as never,
          repoFullName: "acme/widgets",
          author: "alice",
          confirmedContributor: false,
          reputationSkipped: false,
        }),
        `mode=${aiReviewMode}`,
      ).toBe(false);

      expect(contributorAdvisory.findings, `mode=${aiReviewMode}`).toEqual([]);
      expect(reputationAdvisory.findings, `mode=${aiReviewMode}`).toEqual([]);
    }
  });
});
