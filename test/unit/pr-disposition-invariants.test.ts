import { describe, expect, it } from "vitest";
import { MERGE_HOLD_INPUT_KEYS, assessMergeableState, derivePrDisposition, isCommentMergeStateHeld, type MergeHoldInput, type PrDispositionInput } from "../../src/settings/pr-disposition";
import { AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
import { deriveUnifiedStatus, type UnifiedReviewInput } from "../../src/review/unified-comment";
import type { GateCheckConclusion } from "../../src/rules/advisory";

// #8759 (epic #8757): the cross-surface invariant suite. The #8711 incident's root CLASS was four
// surfaces interpreting the raw mergeable_state string independently. These tests pin the shared
// contract: the pure module's own semantics, the planner consuming it verbatim, and the comment
// renderer agreeing with it through the bridge-passed boolean. A regression that re-introduces a
// private raw-string interpretation in any surface shows up here as a cross-surface disagreement.

/** Every declared merge-hold input, off. */
const NO_HOLDS = Object.fromEntries(MERGE_HOLD_INPUT_KEYS.map((key) => [key, false])) as Record<MergeHoldInput, boolean>;

const RAW_STATES = ["clean", "dirty", "behind", "unstable", "blocked", "unknown", "", null, undefined] as const;

function dispositionInput(over: Partial<PrDispositionInput> = {}): PrDispositionInput {
  return {
    mergeableState: "clean",
    reviewGood: true,
    // Every hold OFF, derived from the table rather than restated -- a new hold joins this fixture by
    // existing, which is what stops a hold from being added and silently never exercised here (#9738).
    ...NO_HOLDS,
    ...over,
  };
}

describe("assessMergeableState — THE single interpretation point", () => {
  it("maps every raw state to its one meaning, case-insensitively; anything unrecognized is indeterminate", () => {
    expect(assessMergeableState("clean")).toBe("clean");
    expect(assessMergeableState("CLEAN")).toBe("clean");
    expect(assessMergeableState("dirty")).toBe("conflict");
    expect(assessMergeableState("behind")).toBe("behind");
    expect(assessMergeableState("unstable")).toBe("unstable");
    for (const raw of ["blocked", "unknown", "draft", "", null, undefined]) {
      expect(assessMergeableState(raw), `raw=${String(raw)}`).toBe("indeterminate");
    }
  });
});

describe("derivePrDisposition — module-level invariants over the full state matrix", () => {
  it("wouldMerge implies wouldApprove, for every state x hold combination", () => {
    for (const raw of RAW_STATES) {
      for (const guardrailHit of [false, true]) {
        for (const reviewGood of [false, true]) {
          const d = derivePrDisposition(dispositionInput({ mergeableState: raw, guardrailHit, reviewGood }));
          if (d.wouldMerge) expect(d.wouldApprove, `state=${String(raw)} guardrail=${guardrailHit}`).toBe(true);
        }
      }
    }
  });

  it("held always suppresses both approve and merge", () => {
    for (const raw of RAW_STATES) {
      const d = derivePrDisposition(dispositionInput({ mergeableState: raw, migrationCollisionHold: true }));
      expect(d.heldForManualReview).toBe(true);
      expect(d.wouldApprove).toBe(false);
      expect(d.wouldMerge).toBe(false);
    }
  });

  it("unstable holds by itself; behind/blocked/unknown never hold and stay approvable; conflict is unapprovable but never a hold", () => {
    const unstable = derivePrDisposition(dispositionInput({ mergeableState: "unstable" }));
    expect(unstable.heldForManualReview).toBe(true);
    expect(unstable.heldForUnstableMergeState).toBe(true);
    expect(unstable.wouldApprove).toBe(false);

    for (const raw of ["behind", "blocked", "unknown", undefined]) {
      const d = derivePrDisposition(dispositionInput({ mergeableState: raw as string | undefined }));
      expect(d.heldForManualReview, `state=${String(raw)}`).toBe(false);
      expect(d.wouldApprove, `state=${String(raw)}`).toBe(true);
      expect(d.wouldMerge, `state=${String(raw)}`).toBe(false); // merge stays clean-only
    }

    const conflict = derivePrDisposition(dispositionInput({ mergeableState: "dirty" }));
    expect(conflict.heldForManualReview).toBe(false); // the close path owns conflicts
    expect(conflict.wouldApprove).toBe(false);
    expect(conflict.wouldMerge).toBe(false);
  });

  it("isCommentMergeStateHeld equals derivePrDisposition(...).commentMergeStateHeld for every raw state (equal by construction, pinned)", () => {
    for (const raw of RAW_STATES) {
      expect(isCommentMergeStateHeld(raw), `state=${String(raw)}`).toBe(
        derivePrDisposition(dispositionInput({ mergeableState: raw })).commentMergeStateHeld,
      );
    }
  });
});

// ── Cross-surface: the PLANNER's actions must agree with the disposition for every mergeable state ─────────

function planInput(mergeableState: string | undefined, over: Partial<AgentActionPlanInput> = {}): AgentActionPlanInput {
  return {
    conclusion: "success" as GateCheckConclusion,
    blockerTitles: [],
    autonomy: { approve: "auto", merge: "auto", review_state_label: "auto" },
    autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
    slopGateMinScore: 60,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "passed",
    pr: { labels: [], ...(mergeableState !== undefined ? { mergeableState } : {}) },
    ...over,
  };
}

describe("cross-surface: planner actions agree with the shared disposition (#8759)", () => {
  it("for every mergeable state on a green PR: approve/merge planned iff the disposition allows them, and the label matches held-ness", () => {
    for (const raw of ["clean", "behind", "unstable", "blocked", "unknown", undefined]) {
      const d = derivePrDisposition(dispositionInput({ mergeableState: raw }));
      const actions = planAgentMaintenanceActions(planInput(raw as string | undefined));
      const classes = actions.map((a) => a.actionClass);
      expect(classes.includes("approve"), `approve state=${String(raw)}`).toBe(d.wouldApprove);
      expect(classes.includes("merge"), `merge state=${String(raw)}`).toBe(d.wouldMerge);
      const stateLabel = actions.find((a) => a.actionClass === "label" && a.labelOp !== "remove");
      if (d.heldForManualReview) {
        expect(stateLabel?.label, `label state=${String(raw)}`).toBe(AGENT_LABEL_NEEDS_REVIEW);
      } else {
        expect(stateLabel?.label, `label state=${String(raw)}`).toBe(AGENT_LABEL_READY);
      }
    }
  });

  it("RC3 stays planner-private: a terminally-blocked head suppresses ONLY the merge (disposition still wouldMerge), and a new head lifts it", () => {
    // Same clean/green state; the only variable is the planner-private mergeBlockedSha/headSha pair.
    const blocked = planAgentMaintenanceActions(planInput("clean", { pr: { labels: [], mergeableState: "clean", headSha: "abc", mergeBlockedSha: "abc" } }));
    expect(blocked.map((a) => a.actionClass)).not.toContain("merge");
    expect(derivePrDisposition(dispositionInput({ mergeableState: "clean" })).wouldMerge).toBe(true); // not the disposition's business
    const unblocked = planAgentMaintenanceActions(planInput("clean", { pr: { labels: [], mergeableState: "clean", headSha: "new", mergeBlockedSha: "abc" } }));
    expect(unblocked.map((a) => a.actionClass)).toContain("merge");
    // Absent SHAs (never terminally blocked) also merge — the != null arms.
    const absent = planAgentMaintenanceActions(planInput("clean"));
    expect(absent.map((a) => a.actionClass)).toContain("merge");
  });

  it("dirty (conflict) on a green contributor PR: no approve, no merge, close path engaged — matching the disposition's conflict semantics", () => {
    const d = derivePrDisposition(dispositionInput({ mergeableState: "dirty" }));
    expect(d.wouldApprove).toBe(false);
    const actions = planAgentMaintenanceActions(planInput("dirty", { autonomy: { approve: "auto", merge: "auto", close: "auto" } }));
    const classes = actions.map((a) => a.actionClass);
    expect(classes).not.toContain("approve");
    expect(classes).not.toContain("merge");
    expect(classes).toContain("close");
  });
});

// ── Cross-surface: the COMMENT renderer agrees with the disposition through the bridge boolean ─────────────

function readyInput(readiness: NonNullable<UnifiedReviewInput["readiness"]>): UnifiedReviewInput {
  return { decision: "merge", readiness: { ...readiness, ciState: "passed" } } as UnifiedReviewInput;
}

describe("cross-surface: deriveUnifiedStatus consumes the bridge-resolved boolean and agrees with the disposition (#8759)", () => {
  it("an otherwise-ready status downgrades to held exactly when the shared interpretation says the merge state is held", () => {
    for (const raw of ["clean", "dirty", "behind", "unstable", "blocked", "unknown"]) {
      const held = isCommentMergeStateHeld(raw);
      const status = deriveUnifiedStatus(readyInput({ mergeStateLabel: raw, mergeStateHeld: held } as never));
      expect(status, `state=${raw}`).toBe(held ? "held" : "ready");
    }
  });

  it("the resolved boolean is authoritative over the raw label when both are present", () => {
    // A hypothetical future state the raw-string fallback wouldn't hold on: the boolean wins.
    const status = deriveUnifiedStatus(readyInput({ mergeStateLabel: "totally-new-state", mergeStateHeld: true } as never));
    expect(status).toBe("held");
    const notHeld = deriveUnifiedStatus(readyInput({ mergeStateLabel: "dirty", mergeStateHeld: false } as never));
    expect(notHeld).toBe("ready");
  });

  it("LEGACY callers (no resolved boolean) keep the byte-identical pre-#8759 raw-string behavior, which matches the shared interpretation", () => {
    for (const raw of ["clean", "dirty", "behind", "unstable", "blocked", "unknown"]) {
      const legacy = deriveUnifiedStatus(readyInput({ mergeStateLabel: raw } as never));
      expect(legacy, `state=${raw}`).toBe(isCommentMergeStateHeld(raw) ? "held" : "ready");
    }
  });
});

describe("unstable explained only by an IGNORED check (#9810 follow-up)", () => {
  // Same derivation as `dispositionInput` above: the holds come from the table, never restated here.
  const base = { reviewGood: true, ...NO_HOLDS };

  it("REGRESSION: an unstable state the ignore list fully explains no longer holds", () => {
    // The live half-fix: gate.ignoredCheckRuns removed the check from LoopOver's CI aggregate, but
    // mergeable_state is GitHub's own computation and stayed "unstable" while the check existed at all —
    // so JSONbored/loopover#9816 was still held, reason "mergeable_state is unstable — non-required
    // check(s) not passing: Contributor trust". The ignore was half-effective until this.
    const d = derivePrDisposition({ ...base, mergeableState: "unstable", unstableExplainedByIgnoredChecks: true });
    expect(d.heldForManualReview).toBe(false);
    expect(d.heldForUnstableMergeState).toBe(false);
    expect(d.commentMergeStateHeld).toBe(false);
  });

  it("INVARIANT: unstable from ANY other cause still holds — the flag is not a blanket override", () => {
    const d = derivePrDisposition({ ...base, mergeableState: "unstable", unstableExplainedByIgnoredChecks: false });
    expect(d.heldForManualReview).toBe(true);
    expect(d.heldForUnstableMergeState).toBe(true);
  });

  it("INVARIANT: absent flag behaves exactly as before (byte-identical for every existing caller)", () => {
    expect(derivePrDisposition({ ...base, mergeableState: "unstable" }).heldForManualReview).toBe(true);
  });

  it("INVARIANT: the flag never rescues a PR held for a DIFFERENT reason", () => {
    // An ignored check explaining the instability must not also wave through a guardrail hit.
    const d = derivePrDisposition({ ...base, guardrailHit: true, mergeableState: "unstable", unstableExplainedByIgnoredChecks: true });
    expect(d.heldForManualReview).toBe(true);
    expect(d.wouldMerge).toBe(false);
  });

  it("a dismissed-unstable PR can actually merge when everything else is clean", () => {
    // The point of the fix: not merely "not held", but genuinely mergeable again. GitHub still says
    // unstable, so mergeableState stays the gate on wouldMerge — the PR approves rather than merging.
    const d = derivePrDisposition({ ...base, mergeableState: "unstable", unstableExplainedByIgnoredChecks: true });
    expect(d.wouldApprove).toBe(true);
  });
});

describe("guardrail hold released by a clean escalated review (#9808 second half)", () => {
  const base = {
    reviewGood: true, guardrailHit: true, migrationCollisionHold: false, unlinkedIssueMatchHold: false,
    advisoryCheckHold: false, unlinkedIssueMatchCloseWithoutCloseActing: false, mergeableState: "clean",
  };

  it("REGRESSION: cleared ⇒ the PR proceeds instead of summoning a human", () => {
    // The gap this closes: #9821 shipped the escalated review, but the disposition still held every guarded
    // PR unconditionally — the 74 held PRs / 14 days kept landing on the maintainer, just with better
    // reviews attached. Full-autonomy mode releases the hold when the escalation came back clean.
    const d = derivePrDisposition({ ...base, guardrailEscalationCleared: true });
    expect(d.heldForManualReview).toBe(false);
    expect(d.wouldApprove).toBe(true);
    expect(d.wouldMerge).toBe(true);
  });

  it("INVARIANT: default (flag absent/false) is byte-identical to today — hold", () => {
    expect(derivePrDisposition(base).heldForManualReview).toBe(true);
    expect(derivePrDisposition({ ...base, guardrailEscalationCleared: false }).heldForManualReview).toBe(true);
  });

  it("INVARIANT: cleared releases ONLY the guardrail term — every other hold still holds", () => {
    for (const extra of [
      { migrationCollisionHold: true },
      { unlinkedIssueMatchHold: true },
      { advisoryCheckHold: true },
      { mergeableState: "unstable" },
    ]) {
      const d = derivePrDisposition({ ...base, guardrailEscalationCleared: true, ...extra });
      expect(d.heldForManualReview, JSON.stringify(extra)).toBe(true);
    }
  });

  it("INVARIANT: cleared without reviewGood cannot merge — the release rides ON the clean verdict", () => {
    // The caller only sets cleared when reviewGood, but the disposition must not trust that: a red gate or
    // CI still blocks even if the flag were mis-set upstream.
    const d = derivePrDisposition({ ...base, reviewGood: false, guardrailEscalationCleared: true });
    expect(d.wouldApprove).toBe(false);
    expect(d.wouldMerge).toBe(false);
  });
});
