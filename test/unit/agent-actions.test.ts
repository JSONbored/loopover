import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_LABEL_CHANGES, AGENT_LABEL_MIGRATION_COLLISION, AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, DEFAULT_BLACKLIST_LABEL, DEFAULT_CONTRIBUTOR_CAP_LABEL, DEFAULT_REVIEW_NAG_LABEL, downgradeCloseToHold, downgradeMergeToHold, isProtectedAutomationAuthor, planAgentMaintenanceActions, type AgentActionPlanInput, type PlannedAgentAction } from "../../src/settings/agent-actions";
import { AGENT_LABEL_PENDING_CLOSURE } from "../../src/review/linked-issue-hard-rules";
import { REVIEW_THREAD_BLOCKER_CODE } from "../../src/review/review-thread-findings";
import type { GateCheckConclusion } from "../../src/rules/advisory";
// #module-cycle-regression: forces the SAME module-load cycle that broke once (scoring/model.ts ->
// db/repositories.ts -> agent-actions.ts -> rules/advisory.ts -> scoring/preview.ts -> scoring/model.ts) to
// actually manifest in this test file's own module graph, not just incidentally in other suites. Importing
// agent-actions.ts alone (above) never exercises the OTHER direction of the cycle -- this import does.
import { DEFAULT_ISSUE_DISCOVERY_SHARE } from "../../src/scoring/model";
import { createTestEnv } from "../helpers/d1";

function input(overrides: Partial<AgentActionPlanInput> & { conclusion: GateCheckConclusion }): AgentActionPlanInput {
  return {
    blockerTitles: [],
    autonomy: {},
    autoMaintain: { requireApprovals: 1, mergeMethod: "squash" },
    slopGateMinScore: 60,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "passed",
    pr: { labels: [] },
    ...overrides,
  };
}

const classes = (actions: ReturnType<typeof planAgentMaintenanceActions>) => actions.map((a) => a.actionClass);

describe("planAgentMaintenanceActions (#778)", () => {
  it("plans nothing for SKIPPED; a NEUTRAL verdict FLOWS (advisory non-blocking, never silently undecided)", () => {
    // skipped = genuinely not evaluated → no action.
    expect(planAgentMaintenanceActions(input({ conclusion: "skipped", autonomy: { approve: "auto" } }))).toEqual([]);
    // neutral = advisory-only blockers → NON-blocking: flows to the disposition, earns a label (clean+green here),
    // and is NEVER left silently undecided or auto-closed. (#harm-stop neutral-silent-stuck)
    const neutral = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { merge: "auto", review_state_label: "auto", close: "auto" } })));
    expect(neutral).not.toEqual([]);
    expect(neutral).not.toContain("close");
  });

  it("plans nothing when every class is at a non-acting level", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "observe", request_changes: "observe", close: "observe" }, blockerTitles: ["x"] }));
    expect(plan).toEqual([]);
  });

  it("labels by verdict bucket and is idempotent when the label already exists", () => {
    expect(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"] }))[0]).toMatchObject({ actionClass: "label", label: AGENT_LABEL_CHANGES });
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" } }))[0]).toMatchObject({ actionClass: "label", label: AGENT_LABEL_READY });
    // already labeled → not re-planned
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, pr: { labels: [AGENT_LABEL_READY] } })))).not.toContain("label");
  });

  it("uses repo-configured disposition labels instead of engine fallback names", () => {
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, readyToMergeLabel: "ship-it" }))[0]).toMatchObject({ actionClass: "label", label: "ship-it" });
    expect(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"], changesRequestedLabel: "needs-work" }))[0]).toMatchObject({ actionClass: "label", label: "needs-work" });

    const guarded = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, manualReviewLabel: "human-review", changedPaths: ["src/settings/agent-actions.ts"], hardGuardrailGlobs: ["src/settings/**"], pr: { labels: [], mergeableState: "clean" } }));
    expect(guarded.some((a) => a.actionClass === "label" && a.label === "human-review")).toBe(true);
    expect(classes(guarded)).not.toContain("merge");

    const collision = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, migrationCollisionLabel: "migration-review", migrationCollisionHold: { reason: "live migrations/** collision", comment: "Please rebase." }, pr: { labels: [], mergeableState: "clean" } }));
    expect(collision.some((a) => a.actionClass === "label" && a.label === "migration-review")).toBe(true);
    expect(classes(collision)).not.toContain("merge");
  });

  it("uses manualReviewLabel for manual holds without enabling ready/changes review-state labels", () => {
    const guarded = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, manualReviewLabel: "human-review", readyToMergeLabel: null, changesRequestedLabel: null, changedPaths: ["src/settings/agent-actions.ts"], hardGuardrailGlobs: ["src/settings/**"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
    expect(guarded.some((a) => a.actionClass === "label" && a.label === "human-review" && a.autonomyClass === "merge")).toBe(true);
    expect(guarded.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false);
    expect(guarded.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(false);
    expect(classes(guarded)).not.toContain("merge");
  });

  it("explicit null disables disposition labels without disabling the underlying decision", () => {
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, readyToMergeLabel: null }))).toEqual([]);
    expect(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"], changesRequestedLabel: null }))).toEqual([]);

    const guarded = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, manualReviewLabel: null, changedPaths: ["src/settings/agent-actions.ts"], hardGuardrailGlobs: ["src/settings/**"], pr: { labels: [], mergeableState: "clean" } }));
    expect(classes(guarded)).not.toContain("merge");
    expect(guarded.some((a) => a.actionClass === "label")).toBe(false);

    const collision = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, migrationCollisionLabel: null, migrationCollisionHold: { reason: "live migrations/** collision", comment: "Please rebase." }, pr: { labels: [], mergeableState: "clean" } }));
    expect(classes(collision)).not.toContain("merge");
    expect(collision.some((a) => a.actionClass === "label")).toBe(false);
  });

  it("#label-scoping: the verdict-bucket label carries autonomyClass: review_state_label, is OFF under the broad label class, and defaults OFF entirely", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" } }));
    expect(plan[0]).toMatchObject({ actionClass: "label", autonomyClass: "review_state_label", label: AGENT_LABEL_READY });
    // The broad `label` class alone no longer authorizes this — one-shot mode never sees it without explicit opt-in.
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" } }))).toEqual([]);
    // No autonomy configured at all → nothing (deny-by-default).
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: {} }))).toEqual([]);
  });

  it("NEVER posts a formal request_changes; a blocking contributor PR closes (close acting) and is always labeled", () => {
    // close acting → CLOSE (no formal request_changes review that would block the PR)
    const withClose = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto", review_state_label: "auto" }, blockerTitles: ["Missing linked issue", "Slop risk"] })));
    expect(withClose).toContain("close");
    expect(withClose).not.toContain("request_changes");
    // close NOT acting → just the changes-requested LABEL, never a formal request_changes (which would strand the PR).
    const noClose = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"] })));
    expect(noClose).toContain("label");
    expect(noClose).not.toContain("request_changes");
  });

  it("an action_required verdict is HELD — never request_changes, never closed (awaiting action ≠ failure)", () => {
    const plan = classes(planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { request_changes: "auto", close: "auto", review_state_label: "auto" }, blockerTitles: [] })));
    expect(plan).not.toContain("request_changes");
    // awaiting-action (e.g. a fork's CI awaiting approval) → HELD + labeled, NOT a one-shot close. (#harm-stop)
    expect(plan).not.toContain("close");
    expect(plan).toContain("label");
  });

  it("labels action-required manual holds even when review_state_label is off", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { close: "auto" }, manualReviewLabel: "human-review", readyToMergeLabel: null, changesRequestedLabel: null, blockerTitles: [] }));
    expect(plan).toEqual([
      expect.objectContaining({ actionClass: "label", autonomyClass: "close", label: "human-review", labelOp: "add" }),
    ]);
  });

  describe("stale disposition-label cleanup (#stale-disposition-label-cleanup)", () => {
    it("clears a stale changes-requested label once the PR becomes healthy again", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, pr: { labels: [AGENT_LABEL_CHANGES] } }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_READY }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_CHANGES, labelOp: "remove" }));
    });

    it("does NOT clear manual-review when the PR becomes healthy because it may be a maintainer safety hold", () => {
      // No guardrailHit this pass (changedPaths/hardGuardrailGlobs empty, the default), but the planner has no
      // provenance bit proving manual-review was bot-owned rather than a maintainer-applied hold. It may still
      // add the ready label, but it must not lift the live hold before approve/merge actions run.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto", review_state_label: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [AGENT_LABEL_NEEDS_REVIEW], mergeableState: "clean" } }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_READY }));
      expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "remove")).toBe(false);
      expect(classes(plan)).toEqual(["label", "approve", "merge"]);
    });

    it("clears a stale ready-to-merge label when the PR newly becomes guarded", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, changedPaths: ["src/settings/agent-actions.ts"], hardGuardrailGlobs: ["src/settings/**"], pr: { labels: [AGENT_LABEL_READY], mergeableState: "clean" } }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add" }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_READY, labelOp: "remove" }));
    });

    it("clears every stale sibling at once when more than one lingers from prior passes", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, pr: { labels: [AGENT_LABEL_CHANGES, AGENT_LABEL_MIGRATION_COLLISION] } }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_READY }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_CHANGES, labelOp: "remove" }));
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_MIGRATION_COLLISION, labelOp: "remove" }));
    });

    it("is idempotent — no remove actions when the PR already carries only the correct label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, pr: { labels: [AGENT_LABEL_READY] } }));
      expect(plan.filter((a) => a.actionClass === "label" && a.labelOp === "remove")).toEqual([]);
    });

    it("never emits a remove for a sibling label that is configured OFF (null)", () => {
      // readyToMergeLabel disabled entirely: nothing gets ADDED for the healthy verdict, but a stale
      // changes-requested label from before must still be cleared -- disabling the "success" label must not
      // suppress cleanup of a now-wrong one.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, readyToMergeLabel: null, pr: { labels: [AGENT_LABEL_CHANGES] } }));
      expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false);
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_CHANGES, labelOp: "remove" }));
    });

    it("does NOT clear manual-review when the owner/automation CI-unverified fallback still wants it, even though this ternary picked changes-requested", () => {
      // ciUnverified makes reviewGood false, so the review_state_label ternary picks changes-requested here --
      // but the separate manualHoldReason fallback (ciUnverified branch) still independently wants
      // manual-review and may re-add it later in this same pass; the cleanup must not race against that.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ciState: "unverified", pr: { labels: [AGENT_LABEL_NEEDS_REVIEW] } }));
      expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "remove")).toBe(false);
      expect(plan).toContainEqual(expect.objectContaining({ actionClass: "label", label: AGENT_LABEL_CHANGES }));
    });

    it("never touches the pending-closure label, which has its own dedicated clear path", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, linkedIssueHardRule: { violated: false, reason: null }, pr: { labels: [AGENT_LABEL_PENDING_CLOSURE] } }));
      expect(plan.some((a) => a.label === AGENT_LABEL_PENDING_CLOSURE && a.labelOp === "remove")).toBe(true);
      // exactly one remove for it (from the existing dedicated clearLinkedIssueFlag path), not a duplicate from
      // the new sibling-cleanup loop (which does not include pendingClosure in its sibling set at all).
      expect(plan.filter((a) => a.label === AGENT_LABEL_PENDING_CLOSURE && a.labelOp === "remove")).toHaveLength(1);
    });

    it("dedupes when two disposition-label settings are misconfigured to the identical string", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, manualReviewLabel: "shared-label", migrationCollisionLabel: "shared-label", pr: { labels: ["shared-label"] } }));
      expect(plan.filter((a) => a.actionClass === "label" && a.label === "shared-label" && a.labelOp === "remove")).toHaveLength(1);
    });
  });

  it("approves a passing verdict and never re-approves; a failing one closes (never approves, never requests changes)", () => {
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" } })))).toContain("approve");
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" }, pr: { labels: [], reviewDecision: "APPROVED" } })))).not.toContain("approve");
    // a passing verdict never closes; a failing contributor one closes — never approve, never request_changes.
    const failing = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { approve: "auto", close: "auto" }, blockerTitles: ["x"] })));
    expect(failing).toContain("close");
    expect(failing).not.toContain("approve");
    expect(failing).not.toContain("request_changes");
  });

  it("NEVER approves a base-conflicting PR — it is closed, not approved (#4220)", () => {
    // A green+passing but `dirty` (base-conflict) contributor PR is closed for the conflict; it must NOT also
    // get a spurious "Gittensory approves — safe to merge" review on its way out.
    const conflicting = classes(
      planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", close: "auto" }, ciState: "passed", pr: { labels: [], mergeableState: "dirty" } })),
    );
    expect(conflicting).not.toContain("approve");
    expect(conflicting).toContain("close");
    // A clean PR with the same verdict DOES approve (the conflict is the only difference).
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" }, ciState: "passed", pr: { labels: [], mergeableState: "clean" } })))).toContain("approve");
  });

  describe("re-approval idempotency on the head SHA (stop the re-approve loop)", () => {
    const good = { conclusion: "success" as const, autonomy: { approve: "auto" as const }, ciState: "passed" as const };

    it("approves when approvedHeadSha is ABSENT (never approved this commit)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ ...good, pr: { labels: [], headSha: "abc123" } })));
      expect(plan).toContain("approve");
    });

    it("approves when approvedHeadSha DIFFERS from the live headSha (a new commit pushed)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ ...good, pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } })));
      expect(plan).toContain("approve");
    });

    it("SKIPS approve when approvedHeadSha EQUALS the live headSha (this commit already bot-approved)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ ...good, pr: { labels: [], headSha: "abc123", approvedHeadSha: "abc123" } })));
      expect(plan).not.toContain("approve");
    });

    it("does not affect merge — an already-approved-this-head PR still merges when clean", () => {
      const plan = classes(
        planAgentMaintenanceActions(
          input({ ...good, autonomy: { approve: "auto", merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean", headSha: "abc123", approvedHeadSha: "abc123" } }),
        ),
      );
      expect(plan).not.toContain("approve");
      expect(plan).toContain("merge");
    });
  });

  describe("stale-approval retraction (#2254)", () => {
    it("retracts a stale approval when a newer commit is no longer review-good and the PR stays open (held, not closed)", () => {
      // Owner-authored + closeOwnerAuthors unset ⇒ closeEligible is false ⇒ this bad-verdict PR is HELD, not
      // closed — exactly the case where a stale APPROVE from an earlier good commit would otherwise linger.
      const plan = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: { approve: "auto" }, authorIsOwner: true, pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } }),
      );
      const approveAction = plan.find((a) => a.actionClass === "approve");
      expect(approveAction).toMatchObject({ dismissStaleApproval: true });
    });

    it("pins the retraction to the head that was actually evaluated as stale (#2361)", () => {
      // Without expectedHeadSha, a queued (auto_with_approval) dismissal replays against whatever head is
      // current at accept time — not the head that made the dismissal valid — so a delayed accept could retract
      // a DIFFERENT, newer bot approval than the one this plan pass actually judged stale.
      const plan = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: { approve: "auto_with_approval" }, authorIsOwner: true, pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } }),
      );
      const approveAction = plan.find((a) => a.actionClass === "approve");
      expect(approveAction).toMatchObject({ dismissStaleApproval: true, expectedHeadSha: "newsha" });
    });

    it("does NOT retract when the PR is closing instead — a close makes the stale approval moot", () => {
      const plan = classes(
        planAgentMaintenanceActions(
          input({ conclusion: "failure", autonomy: { approve: "auto", close: "auto" }, blockerTitles: ["x"], pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } }),
        ),
      );
      expect(plan).toContain("close");
      const approveAction = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: { approve: "auto", close: "auto" }, blockerTitles: ["x"], pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } }),
      ).find((a) => a.actionClass === "approve");
      expect(approveAction).toBeUndefined();
    });

    it("does NOT retract when the newer commit IS review-good — a fresh approve fires instead", () => {
      const good = { conclusion: "success" as const, autonomy: { approve: "auto" as const }, ciState: "passed" as const };
      const approveAction = planAgentMaintenanceActions(input({ ...good, pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } })).find((a) => a.actionClass === "approve");
      expect(approveAction).toBeDefined();
      expect(approveAction?.dismissStaleApproval).toBeUndefined(); // a normal fresh approve, not a retraction
    });

    it("does NOT retract when there is nothing stale to retract (never approved, or already approved this exact head)", () => {
      const neverApproved = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: { approve: "auto" }, authorIsOwner: true, pr: { labels: [], headSha: "newsha" } }),
      ).find((a) => a.actionClass === "approve");
      expect(neverApproved).toBeUndefined();

      const sameHead = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: { approve: "auto" }, authorIsOwner: true, pr: { labels: [], headSha: "abc123", approvedHeadSha: "abc123" } }),
      ).find((a) => a.actionClass === "approve");
      expect(sameHead).toBeUndefined();
    });

    it("respects the approve autonomy dial — no retraction when approve is not acting", () => {
      const plan = planAgentMaintenanceActions(
        input({ conclusion: "failure", autonomy: {}, authorIsOwner: true, pr: { labels: [], headSha: "newsha", approvedHeadSha: "oldsha" } }),
      );
      expect(plan.find((a) => a.actionClass === "approve")).toBeUndefined();
    });
  });

  it("merges only a clean, approved, passing PR (reviewDecision drives the approval gate)", () => {
    const ok = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
    expect(ok.find((a) => a.actionClass === "merge")).toMatchObject({ mergeMethod: "squash" });
    // not mergeable-clean → no merge
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, pr: { labels: [], mergeableState: "blocked", reviewDecision: "APPROVED" } })))).not.toContain("merge");
    // approvals not satisfied (requireApprovals 1, not APPROVED) → no merge
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, pr: { labels: [], mergeableState: "clean" } })))).not.toContain("merge");
  });

  it("requireApprovals:0 lets a clean passing PR merge without an explicit approval", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "rebase" }, pr: { labels: [], mergeableState: "clean" } }));
    expect(plan.find((a) => a.actionClass === "merge")).toMatchObject({ mergeMethod: "rebase" });
  });

  it("pins the planned merge to the PR's reviewed head SHA so a staged merge cannot replay against a moved head", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean", headSha: "reviewed-abc" } }));
    expect(plan.find((a) => a.actionClass === "merge")).toMatchObject({ mergeMethod: "squash", expectedHeadSha: "reviewed-abc" });
  });

  it("applies conservative defaults when autoMaintain / slopGateMinScore are omitted", () => {
    // no autoMaintain → requireApprovals defaults to 1 → a clean passing PR without APPROVED does NOT merge
    expect(classes(planAgentMaintenanceActions({ conclusion: "success", blockerTitles: [], autonomy: { merge: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAdmin: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], mergeableState: "clean" } }))).not.toContain("merge");
    // no slopGateMinScore → defaults to 60 → slopRisk 70 counts as noise and closes
    expect(classes(planAgentMaintenanceActions({ conclusion: "failure", blockerTitles: ["x"], autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAdmin: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 70 } }))).toContain("close");
    // ...and slopRisk 50 (below the slop default) STILL closes — a failing-gate contributor PR is closed one-shot
    // regardless of slop; the slop score only adds a close reason (minimize-manual: merge-or-close).
    expect(classes(planAgentMaintenanceActions({ conclusion: "failure", blockerTitles: ["x"], autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAdmin: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 50 } }))).toContain("close");
  });

  it("closes any non-passing contributor PR (citing noise when present), and never closes a passing PR", () => {
    // high slop — closes, slop cited
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], slopGateMinScore: 60, pr: { labels: [], slopRisk: 80 } })))).toContain("close");
    // duplicate — closes, duplicate cited
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 2 } })))).toContain("close");
    // no slop/duplicate noise → STILL closes (the gate failure alone is enough — minimize-manual: merge-or-close)
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], slopRisk: 10 } })))).toContain("close");
    // a review-good (passing + CI green) PR is NEVER closed, even with high slop present
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, pr: { labels: [], slopRisk: 90 } })))).not.toContain("close");
  });

  it("pins the heuristic close to the reviewed head, mirroring merge/approve (#2452)", () => {
    const close = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], headSha: "h-reviewed" } })).find((a) => a.actionClass === "close");
    expect(close).toMatchObject({ closeKind: "heuristic", expectedHeadSha: "h-reviewed" });
  });

  it("#dup-winner disposition seam: the close reason includes the duplicate cause only when linkedDuplicateCount > 0", () => {
    // Loser path (count > 0, the caller's real count): the duplicate cause IS cited in the close reason.
    const loser = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 2 } }));
    const loserClose = loser.find((a) => a.actionClass === "close")!;
    expect(loserClose.reason).toContain("duplicate of another open PR");

    // Winner path (count forced to 0 by dupWinnerLinkedDuplicateCount): the PR STILL closes on its own merits
    // (the gate failure), but the close reason OMITS the duplicate cause.
    const winner = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 0 } }));
    const winnerClose = winner.find((a) => a.actionClass === "close")!;
    expect(classes(winner)).toContain("close");
    expect(winnerClose.reason).not.toContain("duplicate of another open PR");
  });

  it("#dup-winner-credit: names the actual winning PR in the close reason when the election is confident enough", () => {
    const named = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 1, linkedDuplicateWinnerNumber: 99 } }));
    const namedClose = named.find((a) => a.actionClass === "close")!;
    expect(namedClose.reason).toContain("duplicate of open PR #99");
    expect(namedClose.reason).not.toContain("duplicate of another open PR");
  });

  it("#dup-winner-credit: falls back to the generic wording when no winner number is known (null, the nullish arm)", () => {
    const generic = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 1, linkedDuplicateWinnerNumber: null } }));
    const genericClose = generic.find((a) => a.actionClass === "close")!;
    expect(genericClose.reason).toContain("duplicate of another open PR");
  });

  it("keeps every close cause as a structured closeReasons list for historical audit accuracy", () => {
    const plan = planAgentMaintenanceActions(
      input({
        conclusion: "failure",
        autonomy: { close: "auto" },
        blockerTitles: ["AI reviewers found a blocker", "Security scanner found a blocker"],
        ciState: "failed",
        failingCheckNames: ["codecov/patch", "validate"],
        pr: { labels: [], linkedDuplicateCount: 2, mergeableState: "dirty", slopRisk: 80 },
      }),
    );
    const close = plan.find((a) => a.actionClass === "close");

    expect(close?.closeReasons).toEqual([
      "CI is failing (codecov/patch, validate)",
      "conflicts with the base branch — resolve and open a fresh PR",
      "AI reviewers found a blocker",
      "Security scanner found a blocker",
      "slop score 80 ≥ 60",
      "duplicate of another open PR",
    ]);
    expect(close?.reason).toBe(close?.closeReasons?.join("; "));
    for (const reason of close?.closeReasons ?? []) expect(close?.closeComment).toContain(reason);
  });

  it("never plans both merge and close", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED", slopRisk: 95 } }));
    const cls = classes(plan);
    expect(cls).toContain("merge");
    expect(cls).not.toContain("close");
  });

  it("flags requiresApproval for auto_with_approval and not for auto", () => {
    const approval = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto_with_approval" } }));
    expect(approval.find((a) => a.actionClass === "approve")?.requiresApproval).toBe(true);
    const auto = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" } }));
    expect(auto.find((a) => a.actionClass === "approve")?.requiresApproval).toBe(false);
  });

  it("orders actions least → most irreversible (label, review, disposition)", () => {
    // requireApprovals:0 lets merge fire while reviewDecision is still unset, so approve fires too.
    const plan = planAgentMaintenanceActions(
      input({ conclusion: "success", autonomy: { review_state_label: "auto", approve: "auto", merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }),
    );
    expect(classes(plan)).toEqual(["label", "approve", "merge"]);
  });

  describe("hard-guardrail: a changed path matching a guardrail glob forces manual review", () => {
    const guarded = { changedPaths: ["src/scoring/model.ts"], hardGuardrailGlobs: ["src/scoring/**", "scripts/**"] };

    it("does NOT auto-merge a clean+approved+passing PR that touches a guarded path", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("merge");
    });

    it("auto-closes a failing contributor PR on a guarded path; guardrails hold only otherwise-ready PRs", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], ...guarded, pr: { labels: [], slopRisk: 95 } })));
      expect(plan).toContain("close");
    });

    it("auto-closes a guarded contributor PR with red CI — a broken change can't merge regardless (#ci-fail-closes-guarded)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { close: "auto" }, ...guarded, ciState: "failed", ciRequiredContextsVerified: true, pr: { labels: [] } })));
      expect(plan).toContain("close");
    });

    it("auto-closes a guarded contributor PR even when red CI comes from an optional check", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { close: "auto" }, ...guarded, ciState: "failed", failingCheckNames: ["attacker/non-required-status"], ciRequiredContextsVerified: false, pr: { labels: [] } })));
      expect(plan).toContain("close");
    });

    it("auto-closes unknown changed paths with guardrails when CI is red", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: ["src/scoring/**"], ciState: "failed", pr: { labels: [] } })));
      expect(plan).toContain("close");
    });

    it("does NOT approve or auto-merge a passing PR on a guarded path", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean" } })));
      expect(plan).not.toContain("approve");
      expect(plan).not.toContain("merge");
    });

    it("still labels a guarded PR (the reversible action is unaffected — it just falls to a human)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("label");
      expect(plan).not.toContain("merge");
    });

    it("labels a guarded passing PR manual-review (NOT ready-to-merge) and still does not merge it", () => {
      // A guardrail-hit PR that otherwise passes is withheld from auto-merge → the `ready-to-merge` label
      // would be misleading. It must carry the distinct manual-review label instead, and never merge.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.label).not.toBe(AGENT_LABEL_READY);
      expect(label?.reason).toContain("guarded path");
      expect(label?.reason).toContain("src/scoring/model.ts");
      expect(classes(plan)).not.toContain("merge");
    });

    it("truncates the guardrail hold reason to 3 visible paths and counts the rest (#3304)", () => {
      const label = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto" },
        changedPaths: ["src/scoring/a.ts", "src/scoring/b.ts", "src/scoring/c.ts", "src/scoring/d.ts", "src/scoring/e.ts"],
        hardGuardrailGlobs: ["src/scoring/**"],
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      })).find((a) => a.actionClass === "label");
      expect(label?.reason).toContain("src/scoring/a.ts");
      expect(label?.reason).toContain("src/scoring/c.ts");
      expect(label?.reason).not.toContain("src/scoring/d.ts");
      expect(label?.reason).toContain("and 2 more");
    });

    it("explains when guardrail hold is fail-closed because changed files are unavailable", () => {
      const label = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto" },
        changedPaths: [],
        hardGuardrailGlobs: ["src/scoring/**"],
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.reason).toContain("changed-file list unavailable");
    });

    it("does not re-plan the manual-review label when the guarded PR already carries it (idempotent)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ...guarded, pr: { labels: [AGENT_LABEL_NEEDS_REVIEW] } })));
      expect(plan).not.toContain("label");
    });

    it("a guarded BLOCKING PR keeps the changes-requested label (not manual-review)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"], ...guarded, pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("still auto-merges when the changed paths do NOT match any guardrail glob", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, changedPaths: ["docs/readme.md", "src/ui/button.tsx"], hardGuardrailGlobs: ["src/scoring/**", "scripts/**"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).toContain("merge");
      // A clean, non-guarded passing PR keeps the `ready-to-merge` label (the auto-merge it promises happens).
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_READY);
    });
  });

  describe("live migration-collision hold: a live premerge recheck found a same-numbered sibling on the base branch (#2550)", () => {
    const collided = { migrationCollisionHold: { reason: "live migrations/** collision on main (0090: 0090_a.sql, 0090_b.sql)", comment: "Gittensory: a live check found a migration-number collision. Please rebase." } };

    it("does NOT auto-merge a clean+approved+passing PR when a live migration collision is found", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, ...collided, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("merge");
    });

    it("labels the PR migration-collision (NOT manual-review or ready-to-merge) with the live-collision reason", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, ...collided, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_MIGRATION_COLLISION);
      expect(label?.label).not.toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.label).not.toBe(AGENT_LABEL_READY);
      expect(label?.reason).toContain("live migrations/** collision");
      expect(classes(plan)).not.toContain("merge");
    });

    it("attaches the rebase-needed comment to the migration-collision label action", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ...collided, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.comment).toContain("Please rebase");
    });

    it("does not attach a comment for the ordinary guardrail hold (only migration-collision carries one)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, changedPaths: ["src/scoring/model.ts"], hardGuardrailGlobs: ["src/scoring/**"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.comment).toBeUndefined();
    });

    it("does not re-plan the migration-collision label when the PR already carries it (idempotent)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ...collided, pr: { labels: [AGENT_LABEL_MIGRATION_COLLISION] } })));
      expect(plan).not.toContain("label");
    });

    it("a BLOCKING PR keeps the changes-requested label even with a migration collision present (blocker wins)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"], ...collided, pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
      expect(label?.comment).toBeUndefined();
    });

    it("takes priority over a plain guardrail hold when both are true simultaneously — distinct label, not the generic one", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, changedPaths: ["src/scoring/model.ts"], hardGuardrailGlobs: ["src/scoring/**"], ...collided, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_MIGRATION_COLLISION);
    });

    it("still auto-merges when no migration collision is present (absent input, byte-identical to today)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).toContain("merge");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_READY);
    });
  });

  describe("AI-review low-confidence hold (#4603): a sub-floor consensus/split defect under hold_for_review must not one-shot-close", () => {
    const held = {
      aiReviewLowConfidenceHold: {
        reason: "an AI-reviewer defect finding's confidence is below the configured close-confidence floor (0.93)",
        comment: "An AI reviewer flagged a likely defect, but its confidence was below this repository's configured close-confidence floor, so this is held for a maintainer to confirm instead of closing automatically.",
      },
    };

    it("BASELINE: without the hold, a failure verdict one-shot-closes a contributor PR (proves the hold is what changes behavior)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["AI reviewers agree on a likely critical defect"] })));
      expect(plan).toContain("close");
    });

    it("suppresses the one-shot CLOSE when present — the gate still failed, but the PR is held instead", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["AI reviewers agree on a likely critical defect"], ...held })));
      expect(plan).not.toContain("close");
    });

    it("labels the held PR manual-review (via the generic manualHoldReason fallback, close autonomy class) with the hold's comment attached", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, manualReviewLabel: "human-review", blockerTitles: ["AI reviewers agree on a likely critical defect"], ...held }));
      expect(plan).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "close", label: "human-review", labelOp: "add", comment: held.aiReviewLowConfidenceHold.comment }),
      ]);
    });

    it("does NOT suppress a close driven by red CI, even when the hold is also present", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "failed", blockerTitles: ["AI reviewers agree on a likely critical defect"], ...held })));
      expect(plan).toContain("close");
    });

    it("does NOT suppress a close driven by a base conflict, even when the hold is also present", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["AI reviewers agree on a likely critical defect"], ...held, pr: { labels: [], mergeableState: "dirty" } })));
      expect(plan).toContain("close");
    });

    it("never applies to a success/neutral verdict — no hold-driven label without a failure to hold", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", merge: "auto" }, ...held, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("merge");
    });

    it("has no effect for the owner/automation-bot branch (never close-eligible regardless)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, authorIsOwner: true, blockerTitles: ["AI reviewers agree on a likely critical defect"], ...held })));
      expect(plan).not.toContain("close");
    });

    it("absent (undefined) is byte-identical to today — a failure verdict still closes", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"] })));
      expect(plan).toContain("close");
    });
  });

  describe("unlinked-issue-match hold (#unlinked-issue-guardrail, credibility-gate-farming defense)", () => {
    const matched = { unlinkedIssueMatchHold: { reason: "this PR links no issue, but appears to directly solve open issue #42 without linking it (adds the missing dedup key)", comment: "This PR doesn't link an issue, but its diff appears to directly solve #42. Please add a linking reference." } };

    it("does NOT auto-merge a clean+approved+passing PR when a confirmed unlinked-issue match is found", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, ...matched, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("merge");
    });

    it("labels the PR manual-review (the generic label — there is no dedicated one) with the match reason", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, ...matched, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.reason).toContain("open issue #42");
      expect(classes(plan)).not.toContain("merge");
    });

    it("attaches the linking-reference comment to the manual-review label action", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ...matched, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.comment).toContain("directly solve #42");
    });

    it("falls back to manual-review (+ the comment) when review_state_label is OFF", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, ...matched, pr: { labels: [], mergeableState: "clean" } }));
      expect(plan).toEqual([expect.objectContaining({ actionClass: "label", autonomyClass: "merge", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add", comment: matched.unlinkedIssueMatchHold.comment })]);
    });

    it("does not duplicate manual-review when review_state_label IS also acting (only one label action)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, ...matched, pr: { labels: [], mergeableState: "clean" } }));
      expect(plan.filter((a) => a.actionClass === "label")).toHaveLength(1);
    });

    it("does not re-plan the manual-review label when the PR already carries it (idempotent)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ...matched, pr: { labels: [AGENT_LABEL_NEEDS_REVIEW] } })));
      expect(plan).not.toContain("label");
    });

    it("an explicit null manualReviewLabel disables the fallback (respects the operator's own opt-out)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, manualReviewLabel: null, ...matched, pr: { labels: [], mergeableState: "clean" } }));
      expect(plan).toEqual([]);
    });

    it("a BLOCKING PR keeps the changes-requested label even with a confirmed match present (blocker wins, no comment)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { review_state_label: "auto" }, blockerTitles: ["x"], ...matched, pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
      expect(label?.comment).toBeUndefined();
    });

    it("a live migration collision takes priority over an unlinked-issue-match hold when both are true simultaneously", () => {
      const plan = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { review_state_label: "auto" },
        migrationCollisionHold: { reason: "live migrations/** collision on main", comment: "Please rebase." },
        ...matched,
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_MIGRATION_COLLISION);
      expect(label?.comment).toBe("Please rebase.");
    });

    it("still auto-merges when no unlinked-issue-match hold is present (absent input, byte-identical to today)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", merge: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).toContain("merge");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_READY);
    });
  });

  describe("unlinked-issue-match CLOSE — confirmed repeat by the same contributor (#unlinked-issue-guardrail-followup)", () => {
    const repeated = { unlinkedIssueMatchClose: { reason: "this PR appears to directly solve open issue #42 without linking it — a repeat of the same unlinked-issue pattern already flagged on an earlier PR from this contributor", comment: "Closing: please link the issue you're solving going forward." } };

    it("closes one-shot even on a green, clean, approved PR — takes precedence over merge, and pins expectedHeadSha", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto" }, ...repeated, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED", headSha: "abc123" } }));
      expect(classes(plan)).toContain("close");
      expect(classes(plan)).not.toContain("merge");
      expect(plan.find((a) => a.actionClass === "close")?.expectedHeadSha).toBe("abc123");
    });

    it("cites the repeat-specific reason and the standard close message template, tagged closeKind: heuristic (subject to the precision breaker)", () => {
      const action = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ...repeated, pr: { labels: [] } })).find((a) => a.actionClass === "close");
      expect(action?.reason).toContain("#42");
      expect(action?.reason).toContain("repeat");
      expect(action?.closeKind).toBe("heuristic");
      expect(action?.closeConcreteEvidence).not.toBe(true);
      expect(action?.closeComment).toContain("Gittensory is closing this pull request");
      expect(action?.closeComment).toContain("#42");
    });

    it("does not close when the close autonomy class is not acting (deny-by-default floor)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: {}, ...repeated, pr: { labels: [] } }));
      expect(plan).toEqual([]);
    });

    it("HOLDS (never silently merges) a confirmed repeat when merge is auto but close autonomy is not acting (gate-review finding)", () => {
      // Before the fix: heldForManualReview ignored unlinkedIssueMatchClose entirely, so with close autonomy
      // not configured, an otherwise clean/green/approved PR would silently MERGE straight past a confirmed
      // repeat offender -- worse than doing nothing.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, ...repeated, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).not.toContain("merge");
      expect(classes(plan)).not.toContain("close");
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.reason).toContain("#42");
      expect(label?.comment).toContain("Closing:");
    });

    it("still holds (not merges) the fallback case when review_state_label is ALSO acting, without duplicating the label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, ...repeated, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).not.toContain("merge");
      expect(plan.filter((a) => a.actionClass === "label")).toHaveLength(1);
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.reason).toContain("#42");
      expect(label?.comment).toContain("Closing:");
    });

    it("an explicit null manualReviewLabel disables the fallback hold-label (respects the operator's own opt-out) -- the PR still never merges", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, manualReviewLabel: null, ...repeated, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(plan).toEqual([]);
    });

    it("does not close an owner-authored PR (owner exemption applies the same as every other close path)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ...repeated, authorIsOwner: true, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
    });

    it("takes precedence over a linked-issue hard-rule violation's own close reason when both are somehow true (linked-issue-hard-rule wins, per the existing disposition order)", () => {
      // Documents the existing precedence, not a new requirement: willCloseForLinkedIssue is checked BEFORE
      // unlinkedIssueMatchViolated in the disposition chain, so a deterministic hard-rule close still wins.
      const plan = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { close: "auto" },
        linkedIssueHardRule: { violated: true, reason: "Linked issue #1 is assigned to the maintainer." },
        ...repeated,
        pr: { labels: [] },
      })).find((a) => a.actionClass === "close");
      expect(plan?.closeKind).toBe("linked-issue-hard-rule");
    });

    it("still auto-merges when no unlinked-issue-match close is present (absent input, byte-identical to today)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).toContain("merge");
    });
  });

  describe("submission volume is NOT a manual-hold reason — only guardrail paths hold (#minimize-manual)", () => {
    it("a high-volume author's clean+green+approved PR MERGES (the quality gate, not a submission count, is the defense)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", approve: "auto", close: "auto", review_state_label: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).toContain("merge"); // clean → merge, regardless of how many PRs the author has open
      expect(cls).not.toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).not.toBe(AGENT_LABEL_NEEDS_REVIEW); // never held for review
    });
    it("a high-volume author's red-CI PR still CLOSES (the normal close path)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { close: "auto" }, ciState: "failed", pr: { labels: [] } })));
      expect(plan).toContain("close");
    });
    it("ONLY a guardrail-touching review-good PR is held for manual review (needs-human, never merged/closed)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", approve: "auto", close: "auto", review_state_label: "auto" }, hardGuardrailGlobs: ["src/**"], changedPaths: ["src/index.ts"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
    });
  });

  describe("manual-review coverage for every real hold (#manual-review-coverage)", () => {
    it("labels a NEUTRAL contributor PR manual-review when it isn't adverse enough to close and review_state_label is OFF", () => {
      // Deliberately close-only autonomy — review_state_label is left unset (default OFF). Before the fix this
      // fell through with NO action and NO label at all: not review-good (neutral != success) but also not
      // adverse enough to trip willClose (no red CI, no conflict, conclusion isn't "failure") — a silently stuck
      // PR, contradicting the neutral-verdict "never left silently undecided" invariant (#harm-stop
      // neutral-silent-stuck) for exactly the repos that configure manualReviewLabel without review_state_label.
      const plan = planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } }));
      expect(plan).toEqual([expect.objectContaining({ actionClass: "label", autonomyClass: "close", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add" })]);
    });

    it("still plans nothing for the same NEUTRAL contributor PR when close is not acting (deny-by-default floor)", () => {
      // Mirrors "plans nothing when every class is at a non-acting level" -- a repo that hasn't opted `close`
      // into acting must stay fully quiescent; the manual-review fallback must not fire on its own.
      expect(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: {}, ciState: "passed", pr: { labels: [] } }))).toEqual([]);
    });

    it("does NOT label a CI-pending hold manual-review — pending CI is not a manual-review disposition", () => {
      expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto", merge: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "clean" } }))).toEqual([]);
    });

    it("does NOT relabel a protected owner/admin/bot PR that's already covered by willClose's own guard (unaffected by the neutral-hold change)", () => {
      // A conclusion of "failure" for a closeEligible contributor already trips willClose (and hence a real
      // close action), so the manual-review fallback must not ALSO fire on top of it.
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [] } })));
      expect(plan).toEqual(["close"]);
    });

    it("migration-collision hold: falls back to manual-review (+ the rebase comment) when review_state_label is OFF", () => {
      // Before the fix, a migration-collision hold with review_state_label off produced NO action and NO label
      // at all -- a would-merge PR silently stuck with no visible signal and no explanation posted.
      const plan = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto" },
        migrationCollisionHold: { reason: "live migrations/** collision on main", comment: "Please rebase." },
        pr: { labels: [], mergeableState: "clean" },
      }));
      expect(plan).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "merge", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add", comment: "Please rebase." }),
      ]);
    });

    it("migration-collision hold: does NOT duplicate manual-review alongside the dedicated label when review_state_label IS acting", () => {
      const plan = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto", review_state_label: "auto" },
        migrationCollisionHold: { reason: "live migrations/** collision on main", comment: "Please rebase." },
        pr: { labels: [], mergeableState: "clean" },
      }));
      expect(plan.filter((a) => a.actionClass === "label")).toHaveLength(1);
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_MIGRATION_COLLISION);
    });

    it("migration-collision hold: an explicit null manualReviewLabel disables the fallback (respects the operator's own opt-out)", () => {
      const plan = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto" },
        manualReviewLabel: null,
        migrationCollisionHold: { reason: "live migrations/** collision on main", comment: "Please rebase." },
        pr: { labels: [], mergeableState: "clean" },
      }));
      expect(plan).toEqual([]);
    });

    it("requires approval for merge-governed manual-review labels when merge is auto_with_approval", () => {
      const guarded = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto_with_approval" },
        changedPaths: ["src/settings/agent-actions.ts"],
        hardGuardrailGlobs: ["src/settings/**"],
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }));
      expect(guarded).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "merge", requiresApproval: true, label: AGENT_LABEL_NEEDS_REVIEW }),
      ]);

      const collision = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto_with_approval" },
        migrationCollisionHold: { reason: "live migrations/** collision on main", comment: "Please rebase." },
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }));
      expect(collision).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "merge", requiresApproval: true, label: AGENT_LABEL_NEEDS_REVIEW, comment: "Please rebase." }),
      ]);
    });

    it("requires approval for close-governed manual-review labels when close is auto_with_approval", () => {
      const actionRequired = planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { close: "auto_with_approval" }, pr: { labels: [] } }));
      expect(actionRequired).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "close", requiresApproval: true, label: AGENT_LABEL_NEEDS_REVIEW }),
      ]);

      const auto = planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { close: "auto" }, pr: { labels: [] } }));
      expect(auto).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "close", requiresApproval: false, label: AGENT_LABEL_NEEDS_REVIEW }),
      ]);
    });

    it("requires approval for the unlinked-issue-match manual-review fallbacks (1d/1e) when merge is auto_with_approval", () => {
      const holdMatched = { unlinkedIssueMatchHold: { reason: "this PR links no issue, but appears to directly solve open issue #42 without linking it", comment: "Please add a linking reference." } };
      const hold = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto_with_approval" },
        ...holdMatched,
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }));
      expect(hold).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "merge", requiresApproval: true, label: AGENT_LABEL_NEEDS_REVIEW, comment: holdMatched.unlinkedIssueMatchHold.comment }),
      ]);

      const closeRepeated = { unlinkedIssueMatchClose: { reason: "repeat of the same unlinked-issue pattern already flagged", comment: "Closing: please link the issue you're solving going forward." } };
      const closeFallback = planAgentMaintenanceActions(input({
        conclusion: "success",
        autonomy: { merge: "auto_with_approval" },
        ...closeRepeated,
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }));
      expect(closeFallback).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "merge", requiresApproval: true, label: AGENT_LABEL_NEEDS_REVIEW, comment: closeRepeated.unlinkedIssueMatchClose.comment }),
      ]);
    });
  });

  describe("AI/review blockers remain blocking even when CI is green", () => {
    const merging = { aiCiRefutationEnabled: true, autonomy: { merge: "auto" as const, approve: "auto" as const, close: "auto" as const, review_state_label: "auto" as const }, ciState: "passed" as const, pr: { labels: [], mergeableState: "clean" as const, reviewDecision: "APPROVED" as const } };

    it("a consensus-defect failure on a green, clean PR closes instead of merging", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", blockerTitles: ["AI reviewers agree on a likely critical defect"], gateBlockerCodes: ["ai_consensus_defect"], ...merging }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      // "not_required", not undefined -- the planner always tags a heuristic close explicitly (#2478) so a
      // REPLAYED staged action can tell "not CI-driven" apart from "legacy row, field didn't exist yet".
      expect(plan.find((a) => a.actionClass === "close")?.closeRequiresCiState).toBe("not_required");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("a review-split failure on a green PR closes too", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", blockerTitles: ["An AI reviewer flagged a likely blocking defect"], gateBlockerCodes: ["ai_review_split"], ...merging })));
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
    });

    it("the label reports the raw failure verdict, not a refuted success", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: true, autonomy: { review_state_label: "auto" }, ciState: "passed", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
      expect(label?.reason).toBe("verdict=failure");
    });

    it("ignores aiCiRefutationEnabled — enabled=false still closes the same PR", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: false, autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("closes when CI is red", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: true, autonomy: { close: "auto" }, ciState: "failed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("closes a mixed failure", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect", "duplicate_open_pr"], aiCiRefutationEnabled: true, autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("closes a deterministic-only failure", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["slop_high"], aiCiRefutationEnabled: true, autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("closes ai_review_inconclusive when it is represented as a failure", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_review_inconclusive"], aiCiRefutationEnabled: true, autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("closes when codes are omitted too", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", blockerTitles: ["AI reviewers agree on a likely critical defect"], aiCiRefutationEnabled: true, autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } })));
      expect(cls).toContain("close");
    });

    it("a guardrail-touching blocker still closes for a contributor", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: true, autonomy: { merge: "auto", approve: "auto", close: "auto", review_state_label: "auto" }, hardGuardrailGlobs: ["src/**"], changedPaths: ["src/index.ts"], ciState: "passed", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });
  });

  describe("owner-PR guard: never auto-close the repo owner's own PRs", () => {
    it("does NOT auto-close a noisy failing PR authored by the repo owner", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsOwner: true, pr: { labels: [], slopRisk: 95 } })));
      expect(plan).not.toContain("close");
    });

    it("DOES auto-close the same noisy PR when the author is not the owner", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 95 } })));
      expect(plan).toContain("close");
    });

    it("still auto-merges a clean+approved owner PR (the guard blocks only close, never merge)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, authorIsOwner: true, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("merge");
    });

    it("DOES auto-close a failing owner PR when closeOwnerAuthors is enabled (per-repo opt-in)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsOwner: true, closeOwnerAuthors: true, ciState: "passed", pr: { labels: [], slopRisk: 95 } })));
      expect(plan).toContain("close");
    });

    it("still does NOT close an AUTOMATION-bot PR even when closeOwnerAuthors is enabled (bots stay exempt)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsOwner: false, authorIsAutomationBot: true, closeOwnerAuthors: true, ciState: "passed", pr: { labels: [], slopRisk: 95 } })));
      expect(plan).not.toContain("close");
    });

    // #2564: a block-mode CLA finding (cla_consent_missing) reaches the disposition planner exactly like any
    // other configured gate blocker (a conclusion: "failure" + the blocker's title) — it carries no special
    // owner/admin handling of its own, so it inherits the SAME generic isContributor exemption every other
    // blocker gets here. This is the concrete case the CLA gate's "owner/admin exemption" acceptance criterion
    // exercises; it is not a new mechanism.
    it("does NOT auto-close the repo owner's own PR over a CLA-consent-missing blocker; DOES close the same blocker for a contributor", () => {
      const claBlockerTitles = ["CLA consent not confirmed"];
      const ownerPlan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: claBlockerTitles, authorIsOwner: true, ciState: "passed", pr: { labels: [] } })));
      expect(ownerPlan).not.toContain("close");
      const contributorPlan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: claBlockerTitles, authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [] } })));
      expect(contributorPlan).toContain("close");
    });
  });

  describe("admin-login guard: ADMIN_GITHUB_LOGINS gets the same never-auto-close exemption as the owner (#2133)", () => {
    it("does NOT auto-close a noisy failing PR authored by a fleet-operator admin login", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsAdmin: true, pr: { labels: [], slopRisk: 95 } })));
      expect(plan).not.toContain("close");
    });

    it("still auto-merges a clean+approved admin-authored PR (the guard blocks only close, never merge)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, authorIsAdmin: true, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("merge");
    });

    it("DOES auto-close a failing admin PR when closeOwnerAuthors is enabled (the same per-repo opt-in covers admins)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsAdmin: true, closeOwnerAuthors: true, ciState: "passed", pr: { labels: [], slopRisk: 95 } })));
      expect(plan).toContain("close");
    });

    it("does NOT auto-close a red-CI PR authored by an admin login (mirrors the CI-policy owner exemption)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", review_state_label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsAdmin: true, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
    });
  });

  describe("automation-bot guard: never auto-close maintainer-managed accumulator/dependency PRs", () => {
    it("does NOT auto-close a noisy failing PR authored by an automation bot (e.g. the readme-refresh accumulator)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], authorIsAutomationBot: true, pr: { labels: [], slopRisk: 95, linkedDuplicateCount: 3 } })));
      expect(plan).not.toContain("close");
    });

    it("still auto-merges a clean+approved automation-bot PR (the guard blocks only close, never merge)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, authorIsAutomationBot: true, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("merge");
    });
  });

  describe("CI policy: a red CI is never approved/merged — closed (non-owner) / held (owner); pending defers", () => {
    it("does NOT approve or merge a PR whose CI is failing, even when the gate passes and it is clean+approved", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("approve");
      expect(plan).not.toContain("merge");
    });

    it("closes a red-CI non-owner PR and cites the failing checks (even when the gate itself passes)", () => {
      const close = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [] } })).find((a) => a.actionClass === "close");
      expect(close).toBeTruthy();
      expect(close?.reason).toContain("CI is failing");
      expect(close?.reason).toContain("codecov/patch");
      expect(close?.closeRequiresCiState).toBe("failed");
    });

    it("NEVER closes the owner's red-CI PR — held via the changes-requested LABEL only (no blocking request_changes), left open", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", review_state_label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsOwner: true, pr: { labels: [] } }));
      const cls = classes(plan);
      expect(cls).not.toContain("close");
      expect(cls).not.toContain("request_changes"); // never a formal blocking review
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("labels owner's red-CI manual hold with manualReviewLabel when ready/changes labels are disabled", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, manualReviewLabel: "human-review", readyToMergeLabel: null, changesRequestedLabel: null, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsOwner: true, pr: { labels: [] } }));
      expect(plan).toEqual([
        expect.objectContaining({ actionClass: "label", autonomyClass: "close", label: "human-review", labelOp: "add" }),
      ]);
    });

    it("CLOSES (never approves or requests changes) a contributor's red-CI PR and cites the failing check", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", close: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch", "build"], pr: { labels: [] } }));
      const cls = classes(plan);
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("request_changes");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "close")?.reason).toContain("codecov/patch");
    });

    it("labels a red-CI PR changes-requested (not ready-to-merge)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("DEFERS success-path actions while CI is still pending (settle-before-decide)", () => {
      expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }))).toEqual([]);
    });

    it("DEFERS success-path actions when optional visible CI is still pending after required CI passed", () => {
      expect(
        planAgentMaintenanceActions(
          input({
            conclusion: "success",
            autonomy: { review_state_label: "auto", approve: "auto", merge: "auto", close: "auto" },
            autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
            ciState: "passed",
            ciHasPending: true,
            pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
          }),
        ),
      ).toEqual([]);
    });

    it("CLOSES a base-conflicting contributor PR even while CI is still pending (#2968)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto", close: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "dirty", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({
        closeKind: "heuristic",
        closeConcreteEvidence: true,
        closeRequiresMergeableState: true,
      });
    });

    it("CLOSES a blocking gate failure even when optional visible CI is still pending", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { approve: "auto", merge: "auto", close: "auto" }, ciState: "passed", ciHasPending: true, gateBlockerCodes: ["ai_consensus_defect"], blockerTitles: ["AI review found a defect"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({
        closeKind: "heuristic",
        closeConcreteEvidence: false,
        closeRequiresMergeableState: false,
        closeRequiresThreadResolved: false,
      });
    });

    it("REGRESSION (#review-thread-staleness): CLOSES a review-thread-only blocker with closeRequiresThreadResolved: true, so the actuation-time recheck can catch a since-resolved thread", () => {
      const plan = planAgentMaintenanceActions(
        input({
          conclusion: "failure",
          autonomy: { approve: "auto", merge: "auto", close: "auto" },
          ciState: "passed",
          gateBlockerCodes: [REVIEW_THREAD_BLOCKER_CODE],
          blockerTitles: ["reviewer review thread unresolved: fix this"],
          pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
        }),
      );
      const cls = classes(plan);
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({
        closeKind: "heuristic",
        closeRequiresMergeableState: false,
        closeRequiresThreadResolved: true,
      });
    });

    it("REGRESSION (#review-thread-staleness): a mixed blocker set (review thread + something else) still tags closeRequiresThreadResolved: true", () => {
      const plan = planAgentMaintenanceActions(
        input({
          conclusion: "failure",
          autonomy: { approve: "auto", merge: "auto", close: "auto" },
          ciState: "passed",
          gateBlockerCodes: [REVIEW_THREAD_BLOCKER_CODE, "ai_consensus_defect"],
          blockerTitles: ["reviewer review thread unresolved: fix this", "AI review found a defect"],
          pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
        }),
      );
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeKind: "heuristic", closeRequiresThreadResolved: true });
    });

    it("does NOT tag closeRequiresThreadResolved when gateBlockerCodes is absent (nullish ?? [] fallback)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", blockerTitles: ["readiness score too low"], pr: { labels: [] } }));
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeKind: "heuristic", closeRequiresThreadResolved: false });
    });

    it("CLOSES on already-red CI even while an unrelated check is still pending — red is terminal, it does not need the rest to settle", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto", close: "auto" }, ciState: "failed", ciHasPending: true, failingCheckNames: ["build"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "close")).toMatchObject({
        closeKind: "heuristic",
        closeConcreteEvidence: true,
        closeRequiresMergeableState: false,
        closeRequiresCiState: "failed",
      });
    });

    it("DEFERS red-but-pending CI for a non-close-eligible author (owner without closeOwnerAuthors) — the terminal bypass never overrides the close-eligibility guard", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", merge: "auto", close: "auto" }, ciState: "failed", ciHasPending: true, authorIsOwner: true, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(plan).toEqual([]);
    });

    it("HOLDS a contributor's gate-passing PR whose CI is UNVERIFIED — NEVER closes it (fork workflows awaiting approval) (#harm-stop)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { review_state_label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "unverified", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge"); // can't merge — green not confirmed
      expect(cls).not.toContain("approve"); // can't approve — green not confirmed
      expect(cls).not.toContain("close"); // NEVER close on unverified CI — held for review, not killed
      expect(cls).toContain("label"); // labeled (held), never silently stuck
    });

    it("NEVER closes the OWNER's unverified-CI PR — held (no blocking request_changes), left open", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", review_state_label: "auto" }, ciState: "unverified", authorIsOwner: true, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
      expect(plan).not.toContain("request_changes");
    });

    it("merges the same clean+approved PR on green CI but NOT on red CI", () => {
      const base = { conclusion: "success" as const, autonomy: { merge: "auto" as const }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } };
      expect(classes(planAgentMaintenanceActions(input({ ...base, ciState: "passed" })))).toContain("merge");
      expect(classes(planAgentMaintenanceActions(input({ ...base, ciState: "failed" })))).not.toContain("merge");
    });
  });

  describe("linked-issue hard-rule close (#linked-issue-hard-rules)", () => {
    const violation = { violated: true, reason: "Linked issue #5 is labeled `maintainer-only` — it is not open for community PRs." };

    it("closes a CONTRIBUTOR PR with the cited reason on a hard-rule violation", () => {
      const close = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })).find((a) => a.actionClass === "close");
      expect(close).toBeTruthy();
      expect(close?.reason).toBe(violation.reason);
      expect(close?.closeReasons).toEqual([violation.reason]);
      // the cited reason is surfaced in the close comment too
      expect(close?.closeComment).toContain(violation.reason);
    });

    it("pins the linked-issue hard-rule close to the reviewed head, mirroring merge/approve (#2452)", () => {
      const close = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED", headSha: "h-reviewed" } })).find((a) => a.actionClass === "close");
      expect(close).toMatchObject({ closeKind: "linked-issue-hard-rule", expectedHeadSha: "h-reviewed" });
    });

    it("does NOT close the same violation on an OWNER PR (the isContributor guard)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", authorIsOwner: true, linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("close");
    });

    it("does NOT close the same violation on an automation-bot PR", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", authorIsAutomationBot: true, linkedIssueHardRule: violation, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
    });

    it("plans no hard-rule close when there is no violation (a clean review-good PR merges instead)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto" }, ciState: "passed", linkedIssueHardRule: { violated: false, reason: null }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } })));
      expect(plan).toContain("merge");
      expect(plan).not.toContain("close");
    });

    it("plans no hard-rule close when the field is absent entirely", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } })));
      expect(plan).toContain("merge");
      expect(plan).not.toContain("close");
    });

    it("does NOT close when the close autonomy class is not acting (even with a violation)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "observe", review_state_label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
    });

    it("CLOSES even on a GUARDED path (deterministic rule, not an AI verdict — no hold-crucial exemption)", () => {
      // Unlike a gate reject, the linked-issue rule is deterministic, so it fires regardless of guardrailHit.
      const guarded = { changedPaths: ["src/scoring/model.ts"], hardGuardrailGlobs: ["src/scoring/**"] };
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", ...guarded, linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("close");
    });

    it("takes PRECEDENCE over an otherwise-mergeable verdict (never auto-merges a PR linking an ineligible issue)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto", approve: "auto", review_state_label: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).toContain("close");
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("approve");
      // labeled changes-requested, not ready-to-merge
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("falls back to a generic reason when the hard-rule violation carries no reason string", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", linkedIssueHardRule: { violated: true, reason: null }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
      expect(label?.reason).toContain("linked-issue hard rule: ineligible linked issue");
    });
  });

  describe("linked-issue flag-then-close double-check (#linked-issue-verify-before-close)", () => {
    const violation = { violated: true, reason: "Linked issue #5 is labeled `maintainer-only` — it is not open for community PRs." };
    const verifyOn = { verifyBeforeClose: true, closeDelaySeconds: 30 };
    const pendingLabel = (plan: ReturnType<typeof planAgentMaintenanceActions>) => plan.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_PENDING_CLOSURE);

    it("Pass 1 (verify on, label ABSENT): FLAGS (pending-closure label + warning comment), does NOT close", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).not.toContain("close");
      const flag = pendingLabel(plan);
      expect(flag).toBeTruthy();
      expect(flag?.labelOp).toBe("add");
      expect(flag?.comment).toContain("ineligible issue");
      expect(flag?.comment).toContain("~30s");
    });

    it("uses a repo-configured pending-closure label for both verification passes", () => {
      const pass1 = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, pendingClosureLabel: "pending-review-close", ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      const flag = pass1.find((a) => a.actionClass === "label" && a.label === "pending-review-close");
      expect(flag).toMatchObject({ labelOp: "add", closeKind: "linked-issue-hard-rule" });
      expect(classes(pass1)).not.toContain("close");

      const pass2 = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, pendingClosureLabel: "pending-review-close", ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: ["pending-review-close"] } }));
      expect(classes(pass2)).toContain("close");
      expect(pass2.some((a) => a.actionClass === "label" && a.label === "pending-review-close" && a.labelOp !== "remove")).toBe(false);
    });

    it("explicit pendingClosureLabel null disables the flag state and closes immediately", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, pendingClosureLabel: null, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(plan.some((a) => a.actionClass === "label" && a.closeKind === "linked-issue-hard-rule")).toBe(false);
    });

    it("label disabled: falls back to immediate close instead of holding forever without a state label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "observe" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("label approval-gated: falls back to immediate close instead of queueing an unapplied state label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto_with_approval" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("Pass 2 (verify on, label PRESENT, violation persists): CLOSES with the cited reason", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [AGENT_LABEL_PENDING_CLOSURE] } }));
      const close = plan.find((a) => a.actionClass === "close");
      expect(close).toBeTruthy();
      expect(close?.reason).toBe(violation.reason);
      // Pass 2 must NOT re-add the pending-closure label (it is already present).
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("violation CLEARED with the label present: REMOVES the flag (+ resolved comment), never closes", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto", merge: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: { violated: false, reason: null }, linkedIssueVerify: verifyOn, pr: { labels: [AGENT_LABEL_PENDING_CLOSURE], mergeableState: "clean" } }));
      expect(classes(plan)).not.toContain("close");
      const remove = pendingLabel(plan);
      expect(remove?.labelOp).toBe("remove");
      expect(remove?.comment).toContain("resolved");
    });

    it("verifyBeforeClose = false: IMMEDIATE close on first detection (original GAP-5 behavior, no flag)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: { verifyBeforeClose: false, closeDelaySeconds: 30 }, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("owner PR is NEVER flagged or closed even with verify on (isContributor guard)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", authorIsOwner: true, linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).not.toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("Pass 1 does NOT approve or merge an otherwise-mergeable flagged PR (held for verification)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", review_state_label: "auto", approve: "auto", merge: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("close");
      expect(plan).not.toContain("approve");
      expect(plan).not.toContain("merge");
    });
  });
});

describe("assign — auto-assign PR opener (#3182)", () => {
  it("plans nothing when the assign class is not acting (default observe)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: {}, pr: { labels: [], authorLogin: "alice" } }));
    expect(classes(plan)).not.toContain("assign");
  });

  it("plans an assign action for the PR's opener when acting", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto" }, pr: { labels: [], authorLogin: "alice" } }));
    expect(plan).toContainEqual(expect.objectContaining({ actionClass: "assign", assignee: "alice", requiresApproval: false }));
  });

  it("stages for approval under auto_with_approval", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto_with_approval" }, pr: { labels: [], authorLogin: "alice" } }));
    expect(plan).toContainEqual(expect.objectContaining({ actionClass: "assign", assignee: "alice", requiresApproval: true }));
  });

  it("plans nothing when authorLogin is absent (the several narrower callers that never populate it)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto" }, pr: { labels: [] } }));
    expect(classes(plan)).not.toContain("assign");
  });

  it("is independent of merge/close outcome — still plans assign on a failing verdict", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { assign: "auto" }, blockerTitles: ["x"], pr: { labels: [], authorLogin: "alice" } }));
    expect(classes(plan)).toContain("assign");
  });

  it("#assign-before-ci-pending: still plans assign while CI is pending — a reviewed PR must not sit unassigned behind an unrelated stuck check", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED", authorLogin: "alice" } }));
    // Settle-before-decide still defers every success-path action...
    expect(classes(plan)).not.toContain("approve");
    expect(classes(plan)).not.toContain("merge");
    // ...but assign, having no bearing on mergeability, fires anyway.
    expect(plan).toEqual([expect.objectContaining({ actionClass: "assign", assignee: "alice" })]);
  });

  it("plans nothing while CI is pending for a SKIPPED gate — a genuinely-not-evaluated PR is not yet reviewed", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "skipped", autonomy: { assign: "auto" }, ciState: "pending", pr: { labels: [], authorLogin: "alice" } }));
    expect(plan).toEqual([]);
  });

  it("is unaffected by the blacklist/cap/review-nag short-circuits not reaching this far — plans nothing for a blacklisted contributor even with assign acting", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto", close: "auto" }, blacklistMatch: { matched: true, reason: "test" }, pr: { labels: [], authorLogin: "alice" } }));
    expect(classes(plan)).not.toContain("assign");
    expect(classes(plan)).toContain("close");
  });

  describe("assign action linked issue safety", () => {
    it("does not thread PR-body linkedIssues into assignLinkedIssues", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto" }, pr: { labels: [], authorLogin: "alice", linkedIssues: [42, 43] } }));
      const assign = plan.find((a) => a.actionClass === "assign");
      expect(assign).toMatchObject({ actionClass: "assign", assignee: "alice" });
      expect(assign).not.toHaveProperty("assignLinkedIssues");
    });

    it("keeps linkedIssues absence and emptiness equivalent for assign planning", () => {
      for (const pr of [{ labels: [], authorLogin: "alice" }, { labels: [], authorLogin: "alice", linkedIssues: [] }]) {
        const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { assign: "auto" }, pr }));
        const assign = plan.find((a) => a.actionClass === "assign");
        expect(assign).not.toHaveProperty("assignLinkedIssues");
      }
    });
  });
});

describe("isProtectedAutomationAuthor", () => {
  it("matches the maintainer-managed automation accounts (case-insensitive)", () => {
    expect(isProtectedAutomationAuthor("github-actions[bot]")).toBe(true);
    expect(isProtectedAutomationAuthor("GitHub-Actions[bot]")).toBe(true);
    expect(isProtectedAutomationAuthor("dependabot[bot]")).toBe(true);
    expect(isProtectedAutomationAuthor("renovate[bot]")).toBe(true);
  });

  it("does not match human authors or null", () => {
    expect(isProtectedAutomationAuthor("JSONbored")).toBe(false);
    expect(isProtectedAutomationAuthor("some-contributor")).toBe(false);
    expect(isProtectedAutomationAuthor(null)).toBe(false);
    expect(isProtectedAutomationAuthor(undefined)).toBe(false);
  });

  it("extends the base allowlist via PROTECTED_AUTOCLOSE_AUTHORS_EXTRA (#4615), additively", () => {
    const env = createTestEnv({ PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: "mergify[bot], Snyk-Bot" });
    expect(isProtectedAutomationAuthor("mergify[bot]", env)).toBe(true);
    expect(isProtectedAutomationAuthor("snyk-bot", env)).toBe(true); // case-insensitive
    expect(isProtectedAutomationAuthor("github-actions[bot]", env)).toBe(true); // base set still honored
    expect(isProtectedAutomationAuthor("some-other-bot[bot]", env)).toBe(false);
  });

  it("ignores a blank/whitespace-only PROTECTED_AUTOCLOSE_AUTHORS_EXTRA (never shrinks the base set)", () => {
    const blank = createTestEnv({ PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: "  ,  ," });
    expect(isProtectedAutomationAuthor("github-actions[bot]", blank)).toBe(true);
    expect(isProtectedAutomationAuthor("mergify[bot]", blank)).toBe(false);
  });

  it("behaves exactly as before when no env (or no override) is passed", () => {
    expect(isProtectedAutomationAuthor("github-actions[bot]", createTestEnv())).toBe(true);
    expect(isProtectedAutomationAuthor("mergify[bot]", createTestEnv())).toBe(false);
    expect(isProtectedAutomationAuthor("github-actions[bot]", undefined)).toBe(true);
  });
});

describe("downgradeMergeToHold — accuracy circuit-breaker (#self-improve / GAP-4)", () => {
  // A REAL would-merge plan from the planner: gate success + clean + approvals satisfied.
  const wouldMerge = () =>
    planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));

  it("a real would-MERGE plan becomes a HOLD when the breaker is engaged (holdOnly=true)", () => {
    const plan = wouldMerge();
    expect(classes(plan)).toContain("merge"); // sanity: the planner really would auto-merge
    const held = downgradeMergeToHold(plan, true);
    expect(classes(held)).not.toContain("merge"); // the would-merge is downgraded...
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true); // ...to a human hold
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false); // the ready-to-merge promise is dropped
  });

  it("uses repo-configured labels when the merge breaker downgrades a ready PR", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, readyToMergeLabel: "ship-it", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));
    expect(plan.some((a) => a.actionClass === "label" && a.label === "ship-it")).toBe(true);
    const held = downgradeMergeToHold(plan, true, { manualReviewLabel: "human-review", readyToMergeLabel: "ship-it" });
    expect(classes(held)).not.toContain("merge");
    expect(held.some((a) => a.actionClass === "label" && a.label === "human-review")).toBe(true);
    expect(held.some((a) => a.actionClass === "label" && a.label === "ship-it")).toBe(false);
  });

  it("honors null manualReviewLabel when the merge breaker downgrades a ready PR", () => {
    const held = downgradeMergeToHold(wouldMerge(), true, { manualReviewLabel: null });
    expect(classes(held)).not.toContain("merge");
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(false);
  });

  it("holdOnly=false leaves a real would-merge plan UNCHANGED (byte-identical common path)", () => {
    const plan = wouldMerge();
    expect(downgradeMergeToHold(plan, false)).toBe(plan);
  });

  it("REGRESSION: the substitute manual-review label is authorized by `merge` autonomy, not `review_state_label` — it must still post when review_state_label is OFF (the default)", () => {
    // Deliberately autonomy: { merge: "auto" } ONLY — review_state_label is left unset (default OFF), unlike
    // every other test in this block. Before the fix, the pushed label carried autonomyClass: "review_state_label",
    // so the executor's autonomy re-check (agent-action-executor.ts) would DENY it here even though merge autonomy
    // is fully "auto" — the circuit breaker would correctly drop the merge but silently fail to label the PR.
    const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));
    expect(classes(plan)).toEqual(["merge"]); // sanity: review_state_label OFF means no disposition label is planned
    const held = downgradeMergeToHold(plan, true);
    const label = held.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add");
    expect(label?.autonomyClass).toBe("merge");
  });
});

describe("downgradeCloseToHold — close-precision circuit-breaker (#close-precision-breaker)", () => {
  // A REAL heuristic would-close plan from the planner, backed by NO concrete evidence: a bare gate-verdict
  // failure with no red CI, no conflict, no duplicate, and no gate-blocker code the breaker trusts (see
  // CONCRETE_EVIDENCE_BLOCKER_CODES) — an unconfirmed/ambiguous verdict, exactly the class of close the
  // breaker exists to catch. (Deliberately NOT CI-driven: a red-CI close is concrete evidence and now EXEMPT —
  // see the closeConcreteEvidence describe block below.)
  const heuristicClosePlan = () =>
    planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "passed", blockerTitles: ["readiness score too low"], pr: { labels: [] } }));
  // A REAL deterministic linked-issue-hard-rule close (the exempt kind).
  const linkedIssueClosePlan = () =>
    planAgentMaintenanceActions(
      input({
        conclusion: "success",
        autonomy: { close: "auto", review_state_label: "auto" },
        ciState: "passed",
        linkedIssueHardRule: { violated: true, reason: "Linked issue #5 is labeled `maintainer-only` — it is not open for community PRs." },
        linkedIssueVerify: { verifyBeforeClose: false, closeDelaySeconds: 0 },
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }),
    );

  it("a real heuristic would-CLOSE plan drops the close + adds manual-review + KEEPS changes-requested", () => {
    const plan = heuristicClosePlan();
    // sanity: the planner really would heuristically close, with a changes-requested label, and the close
    // carries NO concrete evidence (so it stays subject to the breaker below).
    expect(plan.some((a) => a.actionClass === "close" && a.closeKind === "heuristic" && a.closeConcreteEvidence === false)).toBe(true);
    expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true);
    const held = downgradeCloseToHold(plan, true);
    expect(held.some((a) => a.actionClass === "close")).toBe(false); // the would-close is downgraded...
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true); // ...to a human hold
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true); // changes-requested KEPT
    expect(held.some((a) => a.actionClass === "merge" || a.actionClass === "approve")).toBe(false); // NEVER adds merge/approve
  });

  it("uses repo-configured manualReviewLabel when the close breaker downgrades a heuristic close", () => {
    const held = downgradeCloseToHold(heuristicClosePlan(), true, { manualReviewLabel: "human-review" });
    expect(held.some((a) => a.actionClass === "close")).toBe(false);
    expect(held.some((a) => a.actionClass === "label" && a.label === "human-review" && a.labelOp === "add")).toBe(true);
  });

  it("honors null manualReviewLabel when the close breaker downgrades a heuristic close", () => {
    const held = downgradeCloseToHold(heuristicClosePlan(), true, { manualReviewLabel: null });
    expect(held.some((a) => a.actionClass === "close")).toBe(false);
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(false);
  });

  it("a deterministic linked-issue-hard-rule close is EXEMPT (NOT dropped, no manual-review added)", () => {
    const plan = linkedIssueClosePlan();
    expect(plan.some((a) => a.actionClass === "close" && a.closeKind === "linked-issue-hard-rule")).toBe(true);
    const held = downgradeCloseToHold(plan, true);
    // The deterministic close survives untouched (no heuristic close present → the whole plan is returned as-is).
    expect(held).toBe(plan);
    expect(held.some((a) => a.actionClass === "close" && a.closeKind === "linked-issue-hard-rule")).toBe(true);
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(false);
  });

  it("when BOTH a heuristic and a deterministic close are present, drops ONLY the heuristic one", () => {
    const linkedIssueClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "ineligible issue", closeKind: "linked-issue-hard-rule" };
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failing", closeKind: "heuristic" };
    const held = downgradeCloseToHold([linkedIssueClose, heuristicClose], true);
    expect(held.some((a) => a.actionClass === "close" && a.closeKind === "heuristic")).toBe(false); // heuristic dropped
    expect(held.some((a) => a.actionClass === "close" && a.closeKind === "linked-issue-hard-rule")).toBe(true); // deterministic KEPT
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true);
  });

  it("closeHoldOnly=false leaves a real would-close plan UNCHANGED (byte-identical common path)", () => {
    const plan = heuristicClosePlan();
    expect(downgradeCloseToHold(plan, false)).toBe(plan);
  });

  it("closeHoldOnly=true but NO heuristic close planned (e.g. a would-merge) → no-op (returns plan unchanged)", () => {
    const mergePlan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", review_state_label: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));
    expect(mergePlan.some((a) => a.actionClass === "merge")).toBe(true);
    const out = downgradeCloseToHold(mergePlan, true);
    expect(out).toBe(mergePlan); // unchanged: no heuristic close to drop, merge untouched
    expect(out.some((a) => a.actionClass === "merge")).toBe(true);
  });

  it("does NOT re-add manual-review when it is already present (idempotent)", () => {
    const needsReview: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "guarded", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add" };
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failing", closeKind: "heuristic" };
    const held = downgradeCloseToHold([needsReview, heuristicClose], true);
    expect(held.filter((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toHaveLength(1);
    expect(held.some((a) => a.actionClass === "close")).toBe(false);
  });

  it("carries the dropped close's requiresApproval onto the new label, and defaults to false when it is nullish", () => {
    // requiresApproval=true → carried through (the ?? false LEFT arm with a defined value).
    const approvalClose: PlannedAgentAction = { actionClass: "close", requiresApproval: true, reason: "CI failing", closeKind: "heuristic" };
    const heldApproval = downgradeCloseToHold([approvalClose], true);
    expect(heldApproval.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)?.requiresApproval).toBe(true);
    // requiresApproval nullish (defensive ?? false RIGHT arm) → the label defaults to requiresApproval=false.
    const nullishClose = { actionClass: "close", reason: "CI failing", closeKind: "heuristic" } as unknown as PlannedAgentAction;
    const heldNullish = downgradeCloseToHold([nullishClose], true);
    expect(heldNullish.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)?.requiresApproval).toBe(false);
  });

  it("REGRESSION: the substitute manual-review label is authorized by `close` autonomy, not `review_state_label` — it must still post when review_state_label is OFF (the default)", () => {
    // Deliberately autonomy: { close: "auto" } ONLY — review_state_label is left unset (default OFF), mirroring
    // downgradeMergeToHold's own regression test above. Before the fix, the pushed label carried
    // autonomyClass: "review_state_label" and the executor would deny it even though `close` autonomy is "auto".
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", blockerTitles: ["readiness score too low"], pr: { labels: [] } }));
    expect(plan.some((a) => a.actionClass === "close" && a.closeKind === "heuristic")).toBe(true);
    const held = downgradeCloseToHold(plan, true);
    const label = held.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add");
    expect(label?.autonomyClass).toBe("close");
  });
});

describe("closeConcreteEvidence — concrete-evidence exemption from the close-precision breaker (#hard-blockers-not-ai-judgment)", () => {
  const closeOf = (plan: ReturnType<typeof planAgentMaintenanceActions>) => plan.find((a) => a.actionClass === "close");

  it("red CI (ciFailed) is concrete evidence — planned with closeConcreteEvidence: true", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true });
  });

  it("a base conflict (isConflict) is concrete evidence even with ciState passed (the isConflict OR-arm, ciFailed false)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [], mergeableState: "dirty" } }));
    // closeRequiresMergeableState is the ONLY non-CI close reason the approval queue's accept-time recheck has a
    // cheap live signal for (mergeable_state) -- it must be true here, and ONLY here among the non-CI reasons,
    // so a duplicate/slop/blocker-only close (below) is never subjected to that recheck (gate review finding).
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true, closeRequiresMergeableState: true });
  });

  it("a deterministic linked-issue-overlap duplicate (linkedDuplicateCount > 0) is concrete evidence, but NOT conflict-justified — and IS duplicate-still-open-justified (#dup-winner-staleness)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [], linkedDuplicateCount: 1 } }));
    // Concrete evidence (duplicate) does NOT imply closeRequiresMergeableState -- that field is specifically
    // about whether a base conflict was part of the reason, not whether the close is "trustworthy" in general.
    // closeRequiresDuplicateStillOpen IS true here -- this close's justification depends on a sibling PR's live
    // state, so the executor/approval-queue's live recheck (#dup-winner-staleness) must fire for it.
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true, closeRequiresMergeableState: false, closeRequiresDuplicateStillOpen: true });
  });

  it("linkedDuplicateCount absent (nullish ?? 0) does NOT count as concrete on its own, and closeRequiresDuplicateStillOpen is explicitly false (#dup-winner-staleness)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: false, closeRequiresDuplicateStillOpen: false });
  });

  it("a named duplicate-cluster winner (linkedDuplicateWinnerNumber) is persisted as duplicateWinnerPrNumber so the live recheck knows which sibling to re-verify (#dup-winner-staleness)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [], linkedDuplicateCount: 1, linkedDuplicateWinnerNumber: 42 } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeRequiresDuplicateStillOpen: true, duplicateWinnerPrNumber: 42 });
  });

  it("an unnamed duplicate winner (linkedDuplicateWinnerNumber null — flag off or an ambiguous election) omits duplicateWinnerPrNumber entirely (no stray key), even though closeRequiresDuplicateStillOpen is true (#dup-winner-staleness)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", pr: { labels: [], linkedDuplicateCount: 1, linkedDuplicateWinnerNumber: null } }));
    const close = closeOf(plan);
    expect(close).toMatchObject({ closeKind: "heuristic", closeRequiresDuplicateStillOpen: true });
    expect(close).not.toHaveProperty("duplicateWinnerPrNumber");
  });

  it("a committed secret (secret_leak) is concrete evidence via gateBlockerCodes", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["secret_leak"], blockerTitles: ["Possible leaked secret"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true });
  });

  // The "CONCRETE_EVIDENCE_BLOCKER_CODES parity" describe block below already proves surface_lane_reject and
  // manifest_missing_tests are still hand-typed correctly against their producers; these two exercise them
  // through the actual planAgentMaintenanceActions call, mirroring the direct per-code test secret_leak already
  // has (gate-flagged gap: they were previously only covered generically via Set-membership, never individually).
  it("a registry surface-lane rejection (surface_lane_reject) is concrete evidence via gateBlockerCodes", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["surface_lane_reject"], blockerTitles: ["Registry entry rejected by its surface lane"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true });
  });

  it("missing required manifest tests (manifest_missing_tests) is concrete evidence via gateBlockerCodes", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["manifest_missing_tests"], blockerTitles: ["Manifest change is missing required tests"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true });
  });

  it("a dual-model AI CONSENSUS defect (ai_consensus_defect) is deliberately NOT concrete — two models agreeing is still a judgment call, not deterministic evidence (gate review finding, round 2)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["ai_consensus_defect"], blockerTitles: ["AI review found a defect"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: false });
  });

  it("a SPLIT AI review (ai_review_split) is also NOT concrete — the reviewers disagreed, an even more ambiguous case than consensus", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["ai_review_split"], blockerTitles: ["AI reviewers disagreed"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: false });
  });

  it("a would-close justified ONLY by AI verdicts (consensus + split together) is still not concrete — no deterministic signal present", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["ai_consensus_defect", "ai_review_split"], blockerTitles: ["x", "y"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: false });
  });

  it("an unrecognized/unknown gate-blocker code stays NOT concrete (fail-safe: only explicitly classified codes are trusted)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["some_future_code"], blockerTitles: ["x"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: false });
  });

  it("a mix of one concrete + one non-concrete blocker code is still concrete (the concrete signal alone is sufficient)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["ai_review_split", "secret_leak"], blockerTitles: ["x", "y"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeKind: "heuristic", closeConcreteEvidence: true });
  });

  it("the close-precision breaker EXEMPTS a concrete-evidence close even while engaged (the actual bug this fixes)", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto", review_state_label: "auto" }, ciState: "failed", failingCheckNames: ["ci"], pr: { labels: [] } }));
    expect(closeOf(plan)).toMatchObject({ closeConcreteEvidence: true });
    const held = downgradeCloseToHold(plan, true);
    // Unlike a non-concrete heuristic close, this one SURVIVES the breaker unchanged.
    expect(held).toBe(plan);
    expect(held.some((a) => a.actionClass === "close")).toBe(true);
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(false);
  });

  // Defensive/API-contract test on downgradeCloseToHold's PREDICATE itself, not a claim about what the live
  // planner emits: planAgentMaintenanceActions's disposition branch is an if/else-if chain
  // (flagForLinkedIssue / willCloseForLinkedIssue / canMerge / willClose are mutually exclusive), so it can
  // never plan two `close` actions in one pass — see the real single-close planner-path tests above and in
  // the closeConcreteEvidence describe block below for the actual planner contract. This synthetic two-close
  // input exists purely to prove downgradeCloseToHold discriminates on closeConcreteEvidence alone (not on
  // closeKind or array position), the same "kept deterministic + dropped heuristic" shape that
  // precisionBreakerDowngradeDirections (test/unit/precision-breakers-chain.test.ts) must also get right.
  it("downgradeCloseToHold's predicate discriminates on closeConcreteEvidence alone: a non-concrete heuristic close is downgraded even alongside a KEPT concrete one", () => {
    const concreteClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "hard blocker", closeKind: "heuristic", closeConcreteEvidence: true };
    const ambiguousClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "verdict failed", closeKind: "heuristic", closeConcreteEvidence: false };
    const held = downgradeCloseToHold([concreteClose, ambiguousClose], true);
    expect(held.some((a) => a === concreteClose)).toBe(true);
    expect(held.some((a) => a === ambiguousClose)).toBe(false);
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(true);
  });
});

// #module-cycle-regression: agent-actions.ts imports AI_JUDGMENT_BLOCKER_CODES from rules/advisory.ts, which
// sits inside a real module-load cycle (scoring/model.ts -> db/repositories.ts -> agent-actions.ts ->
// rules/advisory.ts -> scoring/preview.ts -> scoring/model.ts) -- exactly the cycle a top-level array-literal
// spread of another module's export previously broke with a genuine "X is not iterable" failure. This test
// (combined with the scoring/model.ts import at the top of this file, which forces BOTH directions of the
// cycle into this file's own module graph) proves the import stays safe: it is only ever read inside a
// function body (hasConcreteCloseEvidence), never at module-eval time, so it resolves correctly regardless of
// which side of the cycle initializes first.
describe("module-load cycle safety (#module-cycle-regression)", () => {
  it("agent-actions.ts and scoring/model.ts load together without throwing, and the AI-judgment exclusion actually works", () => {
    expect(DEFAULT_ISSUE_DISCOVERY_SHARE).toBe(0.5);
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, ciState: "passed", gateBlockerCodes: ["ai_consensus_defect"], blockerTitles: ["x"], pr: { labels: [] } }));
    expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeConcreteEvidence: false });
  });
});

// #hard-blockers-not-ai-judgment parity guard (nit): CONCRETE_EVIDENCE_BLOCKER_CODES hand-types all 9 of its
// literals rather than importing any of them from their producers, even where a producer DOES export a
// reusable constant (advisory.ts's DUPLICATE_ONLY_BLOCKER_CODES, pre-merge-checks.ts's
// PRE_MERGE_CHECK_BLOCKING_CODE) -- see the doc comment on CONCRETE_EVIDENCE_BLOCKER_CODES for why: this module
// sits inside a real module-load cycle, and an eager top-level import of another module's export broke with a
// genuine "X is not iterable" failure the first time it was tried. This test reads the real producer source
// text and asserts each literal still appears there, so a future rename/removal at the producer fails this
// test immediately instead of silently turning a "concrete evidence" code into a permanently-unreachable Set
// entry.
describe("CONCRETE_EVIDENCE_BLOCKER_CODES parity — hand-typed literals still match their producers", () => {
  const HAND_TYPED_CODES_AND_PRODUCERS: Array<{ code: string; file: string }> = [
    { code: "secret_leak", file: "src/review/safety.ts" },
    { code: "duplicate_pr_risk", file: "src/rules/advisory.ts" },
    { code: "surface_lane_reject", file: "src/review/content-lane-wire.ts" },
    { code: "manifest_missing_tests", file: "src/signals/focus-manifest.ts" },
    { code: "manifest_linked_issue_required", file: "src/signals/focus-manifest.ts" },
    { code: "pre_merge_check_required", file: "src/review/pre-merge-checks.ts" },
    { code: "lockfile_tamper_risk", file: "src/review/lockfile-tamper.ts" },
    { code: "missing_linked_issue", file: "src/rules/advisory.ts" },
    { code: "self_authored_linked_issue", file: "src/rules/advisory.ts" },
  ];

  // Requires the actual producer shape (a `code: "..."` finding property, or a `SOME_CONST = "..."` exported
  // code constant) immediately before the literal -- not just the bare string anywhere in the file, which a
  // stale comment mentioning the code (with no real producer left) could satisfy just as easily.
  const CODE_ASSIGNMENT_PATTERN = (code: string) => new RegExp(`(?:code:\\s*|=\\s*)"${code}"`);

  it.each(HAND_TYPED_CODES_AND_PRODUCERS)("$code is still produced (not merely mentioned) in its producer ($file)", ({ code, file }) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(CODE_ASSIGNMENT_PATTERN(code));
  });
});

describe("contributor blacklist short-circuit (#1425)", () => {
  const blacklisted = (extra: Partial<AgentActionPlanInput> = {}) =>
    // #label-scoping: the blacklist label rides on `close` autonomy, not `label` — no `label: "auto"` needed.
    input({ conclusion: "success", autonomy: { close: "auto", approve: "auto", merge: "auto" }, blacklistMatch: { matched: true, reason: "plagiarism" }, ...extra });

  it("closes + labels a blacklisted contributor's PR, winning over a passing gate (no merit review / merge)", () => {
    const plan = planAgentMaintenanceActions(blacklisted());
    // close is pushed BEFORE its coupled label (#label-close-split-brain) so the executor's outcome-correlation
    // guard always has the close's outcome already recorded by the time it evaluates the label.
    expect(classes(plan)).toEqual(["close", "label"]); // short-circuit: no approve/merge despite a SUCCESS gate
    expect(plan[0]).toMatchObject({ actionClass: "close", closeKind: "blacklist" });
    expect(plan[0]?.closeReasons).toEqual(["blacklisted contributor"]);
    expect(plan[1]).toMatchObject({ actionClass: "label", label: DEFAULT_BLACKLIST_LABEL, labelOp: "add", closeKind: "blacklist" });
    expect(plan[0]?.closeComment).not.toContain("plagiarism");
    expect(plan[0]?.closeComment).toContain("blocked from contributing");
  });

  it("pins the blacklist close to the reviewed head, mirroring merge/approve (#2452)", () => {
    const plan = planAgentMaintenanceActions(blacklisted({ pr: { labels: [], headSha: "h-reviewed" } }));
    expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeKind: "blacklist", expectedHeadSha: "h-reviewed" });
  });

  it("omits expectedHeadSha on the blacklist close when the PR record has no headSha (defensive fallback, #2452)", () => {
    const plan = planAgentMaintenanceActions(blacklisted());
    expect(plan.find((a) => a.actionClass === "close")?.expectedHeadSha).toBeUndefined();
  });

  it("uses the repo-configured blacklistLabel, defaulting to 'slop' when unset", () => {
    expect(planAgentMaintenanceActions(blacklisted({ blacklistLabel: "abuse" }))[1]).toMatchObject({ label: "abuse" });
    expect(DEFAULT_BLACKLIST_LABEL).toBe("slop");
    expect(planAgentMaintenanceActions(blacklisted())[1]).toMatchObject({ label: "slop" });
  });

  it("#label-scoping: an explicit null blacklistLabel closes WITHOUT any label; the label action carries autonomyClass: close", () => {
    const withLabel = planAgentMaintenanceActions(blacklisted());
    expect(classes(withLabel)).toEqual(["close", "label"]);
    expect(withLabel[1]).toMatchObject({ actionClass: "label", autonomyClass: "close" });
    const withoutLabel = planAgentMaintenanceActions(blacklisted({ blacklistLabel: null }));
    expect(classes(withoutLabel)).toEqual(["close"]);
  });

  it("uses the same static public close comment when the entry has no reason", () => {
    const withReason = planAgentMaintenanceActions(blacklisted());
    const withoutReason = planAgentMaintenanceActions(blacklisted({ blacklistMatch: { matched: true, reason: null } }));
    expect(withoutReason[0]?.closeComment).toBe(withReason[0]?.closeComment);
    expect(withoutReason[0]?.closeComment).toContain("blocked from contributing");
  });

  it("fires AHEAD of CI — closes even while CI is still pending (not the pending early-return)", () => {
    expect(classes(planAgentMaintenanceActions(blacklisted({ ciState: "pending" })))).toEqual(["close", "label"]);
  });

  it("NEVER fires for the owner, an admin login, or an automation bot (standing rule) — the PR falls through to normal disposition", () => {
    expect(classes(planAgentMaintenanceActions(blacklisted({ authorIsOwner: true })))).not.toContain("close");
    // #2133: a fleet-operator ADMIN_GITHUB_LOGINS author gets the identical exemption — the blacklist
    // short-circuit must not treat a trusted admin as an ordinary contributor.
    expect(classes(planAgentMaintenanceActions(blacklisted({ authorIsAdmin: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(blacklisted({ authorIsAutomationBot: true })))).not.toContain("close");
  });

  it("no-ops when the author is not matched (normal disposition runs)", () => {
    expect(classes(planAgentMaintenanceActions(blacklisted({ blacklistMatch: { matched: false, reason: null } })))).not.toContain("close");
  });

  it("#label-scoping: the label rides on `close` autonomy, not `label` — `label` alone plans nothing, `close` alone plans both", () => {
    expect(planAgentMaintenanceActions(blacklisted({ autonomy: {} }))).toEqual([]);
    // `label: auto` alone (no `close`) is no longer sufficient — the enforcement label is inseparable from its close.
    expect(planAgentMaintenanceActions(blacklisted({ autonomy: { label: "auto" } }))).toEqual([]);
    // `close: auto` alone (no `label`) is now sufficient for BOTH the close and its label.
    expect(classes(planAgentMaintenanceActions(blacklisted({ autonomy: { close: "auto" } })))).toEqual(["close", "label"]);
  });

  it("never publishes blacklist reason text in the public close comment", () => {
    const privateReason = "internal-case-7421-do-not-publish";
    const plan = planAgentMaintenanceActions(blacklisted({ blacklistMatch: { matched: true, reason: privateReason } }));
    expect(plan[0]?.closeComment).not.toContain(privateReason);
    expect(plan[0]?.closeComment).toContain("blocked from contributing");
  });
});

describe("per-contributor open-item cap short-circuit (#2270)", () => {
  const overCap = (extra: Partial<AgentActionPlanInput> = {}) =>
    // #label-scoping: the cap label rides on `close` autonomy, not `label` — no `label: "auto"` needed.
    input({
      conclusion: "success",
      autonomy: { close: "auto", approve: "auto", merge: "auto" },
      contributorCapMatch: { matched: true, authorLogin: "farmer99", openCount: 3, cap: 2, itemKind: "pull requests" },
      ...extra,
    });

  it("closes + labels an over-cap contributor's PR, winning over a passing gate (no merit review / merge)", () => {
    const plan = planAgentMaintenanceActions(overCap());
    // close is pushed BEFORE its coupled label (#label-close-split-brain) — see the blacklist section above.
    expect(classes(plan)).toEqual(["close", "label"]); // short-circuit: no approve/merge despite a SUCCESS gate
    expect(plan[0]).toMatchObject({ actionClass: "close", closeKind: "contributor_cap" });
    expect(plan[0]?.closeReasons).toEqual(["over the per-contributor open-item cap"]);
    expect(plan[1]).toMatchObject({ actionClass: "label", label: DEFAULT_CONTRIBUTOR_CAP_LABEL, labelOp: "add", closeKind: "contributor_cap" });
  });

  it("interpolates the (public) login/count/cap into the close comment — unlike blacklist's static-only comment", () => {
    const plan = planAgentMaintenanceActions(overCap());
    expect(plan[0]?.closeComment).toContain("@farmer99");
    expect(plan[0]?.closeComment).toContain("3 open pull requests");
    expect(plan[0]?.closeComment).toContain("limit of 2");
  });

  it("itemKind selects the close-comment noun — 'issues' for the issue-path caller, not hardcoded to PRs (regression, gate finding on #2467/#2479)", () => {
    const plan = planAgentMaintenanceActions(
      overCap({ contributorCapMatch: { matched: true, authorLogin: "farmer99", openCount: 3, cap: 2, itemKind: "issues" } }),
    );
    expect(plan[0]?.closeComment).toContain("3 open issues");
    expect(plan[0]?.closeComment).not.toContain("pull requests");
  });

  it("scope 'install' (#2562) describes the cap as install-wide, not this-repository's — same closeKind/label shape", () => {
    const plan = planAgentMaintenanceActions(
      overCap({ contributorCapMatch: { matched: true, authorLogin: "farmer99", openCount: 5, cap: 4, itemKind: "pull requests", scope: "install" } }),
    );
    expect(plan[0]).toMatchObject({ actionClass: "close", closeKind: "contributor_cap" });
    expect(plan[0]?.closeComment).toContain("@farmer99");
    expect(plan[0]?.closeComment).toContain("5 open pull requests");
    expect(plan[0]?.closeComment).toContain("across every repository it gates, combined) of 4");
    expect(plan[0]?.closeComment).not.toContain("this repository's configured limit");
  });

  it("scope 'repository' (default, absent) keeps the original this-repository close-comment wording — back-compat", () => {
    const plan = planAgentMaintenanceActions(overCap()); // overCap's base contributorCapMatch omits `scope`
    expect(plan[0]?.closeComment).toContain("this repository's configured limit");
    expect(plan[0]?.closeComment).not.toContain("across every repository it gates");
  });

  it("uses the repo-configured contributorCapLabel, defaulting to 'over-contributor-limit' when unset", () => {
    expect(planAgentMaintenanceActions(overCap({ contributorCapLabel: "spam-cap" }))[1]).toMatchObject({ label: "spam-cap" });
    expect(DEFAULT_CONTRIBUTOR_CAP_LABEL).toBe("over-contributor-limit");
    expect(planAgentMaintenanceActions(overCap())[1]).toMatchObject({ label: "over-contributor-limit" });
  });

  it("#label-scoping: an explicit null contributorCapLabel closes WITHOUT any label; the label action carries autonomyClass: close", () => {
    const withLabel = planAgentMaintenanceActions(overCap());
    expect(classes(withLabel)).toEqual(["close", "label"]);
    expect(withLabel[1]).toMatchObject({ actionClass: "label", autonomyClass: "close" });
    const withoutLabel = planAgentMaintenanceActions(overCap({ contributorCapLabel: null }));
    expect(classes(withoutLabel)).toEqual(["close"]);
  });

  it("fires AHEAD of CI — closes even while CI is still pending (not the pending early-return)", () => {
    expect(classes(planAgentMaintenanceActions(overCap({ ciState: "pending" })))).toEqual(["close", "label"]);
  });

  it("NEVER fires for the owner, an admin login, or an automation bot (standing rule) — the PR falls through to normal disposition", () => {
    expect(classes(planAgentMaintenanceActions(overCap({ authorIsOwner: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(overCap({ authorIsAdmin: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(overCap({ authorIsAutomationBot: true })))).not.toContain("close");
  });

  it("no-ops when the author is not matched (normal disposition runs)", () => {
    expect(classes(planAgentMaintenanceActions(overCap({ contributorCapMatch: { matched: false, authorLogin: "farmer99", openCount: 1, cap: 2, itemKind: "pull requests" } })))).not.toContain("close");
  });

  it("#label-scoping: the label rides on `close` autonomy, not `label` — `label` alone plans nothing, `close` alone plans both", () => {
    expect(planAgentMaintenanceActions(overCap({ autonomy: {} }))).toEqual([]);
    expect(planAgentMaintenanceActions(overCap({ autonomy: { label: "auto" } }))).toEqual([]);
    expect(classes(planAgentMaintenanceActions(overCap({ autonomy: { close: "auto" } })))).toEqual(["close", "label"]);
  });

  it("is independent of the blacklist short-circuit — a matched blacklist entry still wins when both are present", () => {
    // Blacklist is checked first in the planner; a PR that is BOTH blacklisted and over-cap gets the
    // blacklist's closeKind, not contributor_cap (order matters only when both conditions are true).
    const plan = planAgentMaintenanceActions(
      overCap({ blacklistMatch: { matched: true, reason: "plagiarism" } }),
    );
    expect(plan[0]).toMatchObject({ closeKind: "blacklist" });
  });
});

describe("review-nag cooldown short-circuit (#2463)", () => {
  const nagged = (extra: Partial<AgentActionPlanInput> = {}) =>
    // #label-scoping: the nag label rides on `close` autonomy, not `label` — no `label: "auto"` needed.
    input({
      conclusion: "success",
      autonomy: { close: "auto", approve: "auto", merge: "auto" },
      reviewNagMatch: { matched: true, authorLogin: "chatty-contributor", pingCount: 4, maxPings: 3 },
      ...extra,
    });

  it("closes + labels a nagging contributor's PR, winning over a passing gate (no merit review / merge)", () => {
    const plan = planAgentMaintenanceActions(nagged());
    // close is pushed BEFORE its coupled label (#label-close-split-brain) — see the blacklist section above.
    expect(classes(plan)).toEqual(["close", "label"]); // short-circuit: no approve/merge despite a SUCCESS gate
    expect(plan[0]).toMatchObject({ actionClass: "close", closeKind: "review_nag" });
    expect(plan[0]?.closeReasons).toEqual(["review-nag cooldown"]);
    expect(plan[1]).toMatchObject({ actionClass: "label", label: DEFAULT_REVIEW_NAG_LABEL, labelOp: "add", closeKind: "review_nag" });
    expect(plan[0]?.closeComment).toContain("chatty-contributor");
    expect(plan[0]?.closeComment).toContain("4");
    expect(plan[0]?.closeComment).toContain("3");
  });

  it("pins the review-nag close to the reviewed head, mirroring blacklist/merge/approve", () => {
    const plan = planAgentMaintenanceActions(nagged({ pr: { labels: [], headSha: "h-reviewed" } }));
    expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeKind: "review_nag", expectedHeadSha: "h-reviewed" });
  });

  it("omits expectedHeadSha on the review-nag close when the PR record has no headSha (defensive fallback)", () => {
    const plan = planAgentMaintenanceActions(nagged());
    expect(plan.find((a) => a.actionClass === "close")?.expectedHeadSha).toBeUndefined();
  });

  it("uses the repo-configured reviewNagLabel, defaulting to 'review-nag-cooldown' when unset", () => {
    expect(planAgentMaintenanceActions(nagged({ reviewNagLabel: "cooldown-hit" }))[1]).toMatchObject({ label: "cooldown-hit" });
    expect(DEFAULT_REVIEW_NAG_LABEL).toBe("review-nag-cooldown");
    expect(planAgentMaintenanceActions(nagged())[1]).toMatchObject({ label: "review-nag-cooldown" });
  });

  it("#label-scoping: an explicit null reviewNagLabel closes WITHOUT any label; the label action carries autonomyClass: close", () => {
    const withLabel = planAgentMaintenanceActions(nagged());
    expect(classes(withLabel)).toEqual(["close", "label"]);
    expect(withLabel[1]).toMatchObject({ actionClass: "label", autonomyClass: "close" });
    const withoutLabel = planAgentMaintenanceActions(nagged({ reviewNagLabel: null }));
    expect(classes(withoutLabel)).toEqual(["close"]);
  });

  it("fires AHEAD of CI — closes even while CI is still pending (not the pending early-return)", () => {
    expect(classes(planAgentMaintenanceActions(nagged({ ciState: "pending" })))).toEqual(["close", "label"]);
  });

  it("NEVER fires for the owner, an admin login, or an automation bot (standing rule) — the PR falls through to normal disposition", () => {
    expect(classes(planAgentMaintenanceActions(nagged({ authorIsOwner: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(nagged({ authorIsAdmin: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(nagged({ authorIsAutomationBot: true })))).not.toContain("close");
  });

  it("no-ops when the match is not matched (normal disposition runs)", () => {
    expect(classes(planAgentMaintenanceActions(nagged({ reviewNagMatch: { matched: false, authorLogin: "x", pingCount: 0, maxPings: 3 } })))).not.toContain("close");
  });

  it("#label-scoping: the label rides on `close` autonomy, not `label` — `label` alone plans nothing, `close` alone plans both", () => {
    expect(planAgentMaintenanceActions(nagged({ autonomy: {} }))).toEqual([]);
    expect(planAgentMaintenanceActions(nagged({ autonomy: { label: "auto" } }))).toEqual([]);
    expect(classes(planAgentMaintenanceActions(nagged({ autonomy: { close: "auto" } })))).toEqual(["close", "label"]);
  });
});

describe("screenshot-table gate short-circuit (#2006)", () => {
  const missingTable = (extra: Partial<AgentActionPlanInput> = {}) =>
    input({
      conclusion: "success",
      autonomy: { close: "auto", approve: "auto", merge: "auto" },
      screenshotTableMatch: { matched: true, reason: "This pull request changes UI/visual code but its description is missing a before/after screenshot table." },
      ...extra,
    });

  it("closes a PR missing its screenshot table, winning over a passing gate (no merit review / merge)", () => {
    const plan = planAgentMaintenanceActions(missingTable());
    expect(classes(plan)).toEqual(["close"]); // short-circuit: no approve/merge despite a SUCCESS gate; no coupled label
    expect(plan[0]).toMatchObject({ actionClass: "close", closeKind: "screenshot_table" });
    expect(plan[0]?.closeReasons).toEqual(["missing before/after screenshot table"]);
  });

  it("interpolates the configured contract reason into the close comment", () => {
    const plan = planAgentMaintenanceActions(missingTable());
    expect(plan[0]?.closeComment).toContain("before/after screenshot table");
    expect(plan[0]?.closeComment).toContain("This is an automated maintenance action.");
  });

  it("falls back to a generic reason when the trigger passes reason: null", () => {
    const plan = planAgentMaintenanceActions(missingTable({ screenshotTableMatch: { matched: true, reason: null } }));
    expect(plan[0]?.closeComment).toContain("missing a before/after screenshot table");
  });

  it("pins the close to the reviewed head, mirroring blacklist/contributor-cap/review-nag", () => {
    const plan = planAgentMaintenanceActions(missingTable({ pr: { labels: [], headSha: "h-reviewed" } }));
    expect(plan.find((a) => a.actionClass === "close")).toMatchObject({ closeKind: "screenshot_table", expectedHeadSha: "h-reviewed" });
  });

  it("omits expectedHeadSha when the PR record has no headSha (defensive fallback)", () => {
    const plan = planAgentMaintenanceActions(missingTable());
    expect(plan.find((a) => a.actionClass === "close")?.expectedHeadSha).toBeUndefined();
  });

  it("fires AHEAD of CI — closes even while CI is still pending (not the pending early-return)", () => {
    expect(classes(planAgentMaintenanceActions(missingTable({ ciState: "pending" })))).toEqual(["close"]);
  });

  it("NEVER fires for the owner, an admin login, or an automation bot (standing rule) — the PR falls through to normal disposition", () => {
    expect(classes(planAgentMaintenanceActions(missingTable({ authorIsOwner: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(missingTable({ authorIsAdmin: true })))).not.toContain("close");
    expect(classes(planAgentMaintenanceActions(missingTable({ authorIsAutomationBot: true })))).not.toContain("close");
  });

  it("no-ops when the match is not matched (normal disposition runs)", () => {
    expect(classes(planAgentMaintenanceActions(missingTable({ screenshotTableMatch: { matched: false, reason: null } })))).not.toContain("close");
  });

  it("plans nothing when `close` autonomy is not acting", () => {
    expect(planAgentMaintenanceActions(missingTable({ autonomy: {} }))).toEqual([]);
    expect(classes(planAgentMaintenanceActions(missingTable({ autonomy: { close: "auto" } })))).toEqual(["close"]);
  });

  it("is exempt from the close-precision breaker (no closeKind: 'heuristic', mirroring blacklist/contributor-cap/review-nag)", () => {
    const plan = planAgentMaintenanceActions(missingTable());
    const closeAction = plan.find((a) => a.actionClass === "close");
    const downgraded = downgradeCloseToHold(plan, true, {});
    expect(downgraded).toEqual(plan);
    expect(closeAction?.closeKind).not.toBe("heuristic");
  });

  it("is independent of the blacklist short-circuit — a matched blacklist entry still wins when both are present", () => {
    const plan = planAgentMaintenanceActions(missingTable({ blacklistMatch: { matched: true, reason: "plagiarism" } }));
    expect(plan[0]).toMatchObject({ closeKind: "blacklist" });
  });
});
