import { describe, expect, it } from "vitest";
import { AGENT_LABEL_CHANGES, AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, DEFAULT_BLACKLIST_LABEL, downgradeCloseToHold, downgradeMergeToHold, isProtectedAutomationAuthor, planAgentMaintenanceActions, type AgentActionPlanInput, type PlannedAgentAction } from "../../src/settings/agent-actions";
import { AGENT_LABEL_PENDING_CLOSURE } from "../../src/review/linked-issue-hard-rules";
import type { GateCheckConclusion } from "../../src/rules/advisory";

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
    const neutral = classes(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { merge: "auto", label: "auto", close: "auto" } })));
    expect(neutral).not.toEqual([]);
    expect(neutral).not.toContain("close");
  });

  it("plans nothing when every class is at a non-acting level", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { label: "suggest", request_changes: "propose", close: "observe" }, blockerTitles: ["x"] }));
    expect(plan).toEqual([]);
  });

  it("labels by verdict bucket and is idempotent when the label already exists", () => {
    expect(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { label: "auto" }, blockerTitles: ["x"] }))[0]).toMatchObject({ actionClass: "label", label: AGENT_LABEL_CHANGES });
    expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" } }))[0]).toMatchObject({ actionClass: "label", label: AGENT_LABEL_READY });
    // already labeled → not re-planned
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" }, pr: { labels: [AGENT_LABEL_READY] } })))).not.toContain("label");
  });

  it("NEVER posts a formal request_changes; a blocking contributor PR closes (close acting) and is always labeled", () => {
    // close acting → CLOSE (no formal request_changes review that would block the PR)
    const withClose = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto", label: "auto" }, blockerTitles: ["Missing linked issue", "Slop risk"] })));
    expect(withClose).toContain("close");
    expect(withClose).not.toContain("request_changes");
    // close NOT acting → just the changes-requested LABEL, never a formal request_changes (which would strand the PR).
    const noClose = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { label: "auto" }, blockerTitles: ["x"] })));
    expect(noClose).toContain("label");
    expect(noClose).not.toContain("request_changes");
  });

  it("an action_required verdict is HELD — never request_changes, never closed (awaiting action ≠ failure)", () => {
    const plan = classes(planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { request_changes: "auto", close: "auto", label: "auto" }, blockerTitles: [] })));
    expect(plan).not.toContain("request_changes");
    // awaiting-action (e.g. a fork's CI awaiting approval) → HELD + labeled, NOT a one-shot close. (#harm-stop)
    expect(plan).not.toContain("close");
    expect(plan).toContain("label");
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
      input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }),
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
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("label");
      expect(plan).not.toContain("merge");
    });

    it("labels a guarded passing PR `needs-human-review` (NOT `ready-to-merge`) and still does not merge it", () => {
      // A guardrail-hit PR that otherwise passes is withheld from auto-merge → the `ready-to-merge` label
      // would be misleading. It must carry the distinct `needs-human-review` label instead, and never merge.
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", merge: "auto" }, ...guarded, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const label = plan.find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
      expect(label?.label).not.toBe(AGENT_LABEL_READY);
      expect(label?.reason).toContain("guarded path");
      expect(classes(plan)).not.toContain("merge");
    });

    it("does not re-plan the needs-human-review label when the guarded PR already carries it (idempotent)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" }, ...guarded, pr: { labels: [AGENT_LABEL_NEEDS_REVIEW] } })));
      expect(plan).not.toContain("label");
    });

    it("a guarded BLOCKING PR keeps the changes-requested label (not needs-human-review)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { label: "auto" }, blockerTitles: ["x"], ...guarded, pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("still auto-merges when the changed paths do NOT match any guardrail glob", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", merge: "auto" }, changedPaths: ["docs/readme.md", "src/ui/button.tsx"], hardGuardrailGlobs: ["src/scoring/**", "scripts/**"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      expect(classes(plan)).toContain("merge");
      // A clean, non-guarded passing PR keeps the `ready-to-merge` label (the auto-merge it promises happens).
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_READY);
    });
  });

  describe("submission volume is NOT a manual-hold reason — only guardrail paths hold (#minimize-manual)", () => {
    it("a high-volume author's clean+green+approved PR MERGES (the quality gate, not a submission count, is the defense)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", approve: "auto", close: "auto", label: "auto" }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
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
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", approve: "auto", close: "auto", label: "auto" }, hardGuardrailGlobs: ["src/**"], changedPaths: ["src/index.ts"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("approve");
      expect(cls).not.toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
    });
  });

  describe("AI/review blockers remain blocking even when CI is green", () => {
    const merging = { aiCiRefutationEnabled: true, autonomy: { merge: "auto" as const, approve: "auto" as const, close: "auto" as const, label: "auto" as const }, ciState: "passed" as const, pr: { labels: [], mergeableState: "clean" as const, reviewDecision: "APPROVED" as const } };

    it("a consensus-defect failure on a green, clean PR closes instead of merging", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", blockerTitles: ["AI reviewers agree on a likely critical defect"], gateBlockerCodes: ["ai_consensus_defect"], ...merging }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("a review-split failure on a green PR closes too", () => {
      const cls = classes(planAgentMaintenanceActions(input({ conclusion: "failure", blockerTitles: ["An AI reviewer flagged a likely blocking defect"], gateBlockerCodes: ["ai_review_split"], ...merging })));
      expect(cls).not.toContain("merge");
      expect(cls).toContain("close");
    });

    it("the label reports the raw failure verdict, not a refuted success", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: true, autonomy: { label: "auto" }, ciState: "passed", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
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
      const plan = planAgentMaintenanceActions(input({ conclusion: "failure", gateBlockerCodes: ["ai_consensus_defect"], aiCiRefutationEnabled: true, autonomy: { merge: "auto", approve: "auto", close: "auto", label: "auto" }, hardGuardrailGlobs: ["src/**"], changedPaths: ["src/index.ts"], ciState: "passed", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
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
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsAdmin: true, pr: { labels: [] } })));
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
    });

    it("NEVER closes the owner's red-CI PR — held via the changes-requested LABEL only (no blocking request_changes), left open", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsOwner: true, pr: { labels: [] } }));
      const cls = classes(plan);
      expect(cls).not.toContain("close");
      expect(cls).not.toContain("request_changes"); // never a formal blocking review
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
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
      const label = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("DEFERS every action while CI is still pending (settle-before-decide)", () => {
      expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }))).toEqual([]);
    });

    it("DEFERS every action when optional visible CI is still pending after required CI passed", () => {
      expect(
        planAgentMaintenanceActions(
          input({
            conclusion: "success",
            autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" },
            autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
            ciState: "passed",
            ciHasPending: true,
            pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
          }),
        ),
      ).toEqual([]);
    });

    it("HOLDS a contributor's gate-passing PR whose CI is UNVERIFIED — NEVER closes it (fork workflows awaiting approval) (#harm-stop)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "unverified", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge"); // can't merge — green not confirmed
      expect(cls).not.toContain("approve"); // can't approve — green not confirmed
      expect(cls).not.toContain("close"); // NEVER close on unverified CI — held for review, not killed
      expect(cls).toContain("label"); // labeled (held), never silently stuck
    });

    it("NEVER closes the OWNER's unverified-CI PR — held (no blocking request_changes), left open", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto", label: "auto" }, ciState: "unverified", authorIsOwner: true, pr: { labels: [] } })));
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
      // the cited reason is surfaced in the close comment too
      expect(close?.closeComment).toContain(violation.reason);
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
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "observe", label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
    });

    it("CLOSES even on a GUARDED path (deterministic rule, not an AI verdict — no hold-crucial exemption)", () => {
      // Unlike a gate reject, the linked-issue rule is deterministic, so it fires regardless of guardrailHit.
      const guarded = { changedPaths: ["src/scoring/model.ts"], hardGuardrailGlobs: ["src/scoring/**"] };
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto" }, ciState: "passed", ...guarded, linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("close");
    });

    it("takes PRECEDENCE over an otherwise-mergeable verdict (never auto-merges a PR linking an ineligible issue)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", close: "auto", approve: "auto", label: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: violation, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).toContain("close");
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("approve");
      // labeled changes-requested, not ready-to-merge
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
    });
  });

  describe("linked-issue flag-then-close double-check (#linked-issue-verify-before-close)", () => {
    const violation = { violated: true, reason: "Linked issue #5 is labeled `maintainer-only` — it is not open for community PRs." };
    const verifyOn = { verifyBeforeClose: true, closeDelaySeconds: 30 };
    const pendingLabel = (plan: ReturnType<typeof planAgentMaintenanceActions>) => plan.find((a) => a.actionClass === "label" && a.label === AGENT_LABEL_PENDING_CLOSURE);

    it("Pass 1 (verify on, label ABSENT): FLAGS (pending-closure label + warning comment), does NOT close", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).not.toContain("close");
      const flag = pendingLabel(plan);
      expect(flag).toBeTruthy();
      expect(flag?.labelOp).toBe("add");
      expect(flag?.comment).toContain("ineligible issue");
      expect(flag?.comment).toContain("~30s");
    });

    it("label disabled: falls back to immediate close instead of holding forever without a state label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "observe" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("label approval-gated: falls back to immediate close instead of queueing an unapplied state label", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto_with_approval" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("Pass 2 (verify on, label PRESENT, violation persists): CLOSES with the cited reason", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [AGENT_LABEL_PENDING_CLOSURE] } }));
      const close = plan.find((a) => a.actionClass === "close");
      expect(close).toBeTruthy();
      expect(close?.reason).toBe(violation.reason);
      // Pass 2 must NOT re-add the pending-closure label (it is already present).
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("violation CLEARED with the label present: REMOVES the flag (+ resolved comment), never closes", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto", merge: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: { violated: false, reason: null }, linkedIssueVerify: verifyOn, pr: { labels: [AGENT_LABEL_PENDING_CLOSURE], mergeableState: "clean" } }));
      expect(classes(plan)).not.toContain("close");
      const remove = pendingLabel(plan);
      expect(remove?.labelOp).toBe("remove");
      expect(remove?.comment).toContain("resolved");
    });

    it("verifyBeforeClose = false: IMMEDIATE close on first detection (original GAP-5 behavior, no flag)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto" }, ciState: "passed", linkedIssueHardRule: violation, linkedIssueVerify: { verifyBeforeClose: false, closeDelaySeconds: 30 }, pr: { labels: [] } }));
      expect(classes(plan)).toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("owner PR is NEVER flagged or closed even with verify on (isContributor guard)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto" }, ciState: "passed", authorIsOwner: true, linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [] } }));
      expect(classes(plan)).not.toContain("close");
      expect(pendingLabel(plan)).toBeFalsy();
    });

    it("Pass 1 does NOT approve or merge an otherwise-mergeable flagged PR (held for verification)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", label: "auto", approve: "auto", merge: "auto" }, ciState: "passed", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, linkedIssueHardRule: violation, linkedIssueVerify: verifyOn, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).not.toContain("close");
      expect(plan).not.toContain("approve");
      expect(plan).not.toContain("merge");
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
});

describe("downgradeMergeToHold — accuracy circuit-breaker (#self-improve / GAP-4)", () => {
  // A REAL would-merge plan from the planner: gate success + clean + approvals satisfied.
  const wouldMerge = () =>
    planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", label: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));

  it("a real would-MERGE plan becomes a HOLD when the breaker is engaged (holdOnly=true)", () => {
    const plan = wouldMerge();
    expect(classes(plan)).toContain("merge"); // sanity: the planner really would auto-merge
    const held = downgradeMergeToHold(plan, true);
    expect(classes(held)).not.toContain("merge"); // the would-merge is downgraded...
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true); // ...to a human hold
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false); // the ready-to-merge promise is dropped
  });

  it("holdOnly=false leaves a real would-merge plan UNCHANGED (byte-identical common path)", () => {
    const plan = wouldMerge();
    expect(downgradeMergeToHold(plan, false)).toBe(plan);
  });
});

describe("downgradeCloseToHold — close-precision circuit-breaker (#close-precision-breaker)", () => {
  // A REAL heuristic would-close plan from the planner: red CI on a contributor PR → changes-requested label +
  // a heuristic close.
  const heuristicClosePlan = () =>
    planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto", label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], blockerTitles: ["x"], pr: { labels: [] } }));
  // A REAL deterministic linked-issue-hard-rule close (the exempt kind).
  const linkedIssueClosePlan = () =>
    planAgentMaintenanceActions(
      input({
        conclusion: "success",
        autonomy: { close: "auto", label: "auto" },
        ciState: "passed",
        linkedIssueHardRule: { violated: true, reason: "Linked issue #5 is labeled `maintainer-only` — it is not open for community PRs." },
        linkedIssueVerify: { verifyBeforeClose: false, closeDelaySeconds: 0 },
        pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" },
      }),
    );

  it("a real heuristic would-CLOSE plan drops the close + adds needs-human-review + KEEPS changes-requested", () => {
    const plan = heuristicClosePlan();
    // sanity: the planner really would heuristically close, with a changes-requested label.
    expect(plan.some((a) => a.actionClass === "close" && a.closeKind === "heuristic")).toBe(true);
    expect(plan.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true);
    const held = downgradeCloseToHold(plan, true);
    expect(held.some((a) => a.actionClass === "close")).toBe(false); // the would-close is downgraded...
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true); // ...to a human hold
    expect(held.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true); // changes-requested KEPT
    expect(held.some((a) => a.actionClass === "merge" || a.actionClass === "approve")).toBe(false); // NEVER adds merge/approve
  });

  it("a deterministic linked-issue-hard-rule close is EXEMPT (NOT dropped, no needs-human-review added)", () => {
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
    const mergePlan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", label: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, pr: { labels: [], mergeableState: "clean" } }));
    expect(mergePlan.some((a) => a.actionClass === "merge")).toBe(true);
    const out = downgradeCloseToHold(mergePlan, true);
    expect(out).toBe(mergePlan); // unchanged: no heuristic close to drop, merge untouched
    expect(out.some((a) => a.actionClass === "merge")).toBe(true);
  });

  it("does NOT re-add needs-human-review when it is already present (idempotent)", () => {
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
});

describe("contributor blacklist short-circuit (#1425)", () => {
  const blacklisted = (extra: Partial<AgentActionPlanInput> = {}) =>
    input({ conclusion: "success", autonomy: { label: "auto", close: "auto", approve: "auto", merge: "auto" }, blacklistMatch: { matched: true, reason: "plagiarism" }, ...extra });

  it("labels + closes a blacklisted contributor's PR, winning over a passing gate (no merit review / merge)", () => {
    const plan = planAgentMaintenanceActions(blacklisted());
    expect(classes(plan)).toEqual(["label", "close"]); // short-circuit: no approve/merge despite a SUCCESS gate
    expect(plan[0]).toMatchObject({ actionClass: "label", label: DEFAULT_BLACKLIST_LABEL, labelOp: "add" });
    expect(plan[1]).toMatchObject({ actionClass: "close", closeKind: "blacklist" });
    expect(plan[1]?.closeComment).not.toContain("plagiarism");
    expect(plan[1]?.closeComment).toContain("blocked from contributing");
  });

  it("uses the repo-configured blacklistLabel, defaulting to 'slop' when unset", () => {
    expect(planAgentMaintenanceActions(blacklisted({ blacklistLabel: "abuse" }))[0]).toMatchObject({ label: "abuse" });
    expect(DEFAULT_BLACKLIST_LABEL).toBe("slop");
    expect(planAgentMaintenanceActions(blacklisted())[0]).toMatchObject({ label: "slop" });
  });

  it("uses the same static public close comment when the entry has no reason", () => {
    const withReason = planAgentMaintenanceActions(blacklisted());
    const withoutReason = planAgentMaintenanceActions(blacklisted({ blacklistMatch: { matched: true, reason: null } }));
    expect(withoutReason[1]?.closeComment).toBe(withReason[1]?.closeComment);
    expect(withoutReason[1]?.closeComment).toContain("blocked from contributing");
  });

  it("fires AHEAD of CI — closes even while CI is still pending (not the pending early-return)", () => {
    expect(classes(planAgentMaintenanceActions(blacklisted({ ciState: "pending" })))).toEqual(["label", "close"]);
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

  it("respects autonomy: observe plans nothing (still short-circuits); label-only labels but does not close", () => {
    expect(planAgentMaintenanceActions(blacklisted({ autonomy: {} }))).toEqual([]);
    expect(classes(planAgentMaintenanceActions(blacklisted({ autonomy: { label: "auto" } })))).toEqual(["label"]);
  });

  it("never publishes blacklist reason text in the public close comment", () => {
    const privateReason = "internal-case-7421-do-not-publish";
    const plan = planAgentMaintenanceActions(blacklisted({ blacklistMatch: { matched: true, reason: privateReason } }));
    expect(plan[1]?.closeComment).not.toContain(privateReason);
    expect(plan[1]?.closeComment).toContain("blocked from contributing");
  });
});
