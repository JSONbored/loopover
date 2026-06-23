import { describe, expect, it } from "vitest";
import { AGENT_LABEL_CHANGES, AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, isProtectedAutomationAuthor, planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
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
    authorIsAutomationBot: false,
    ciState: "passed",
    pr: { labels: [] },
    ...overrides,
  };
}

const classes = (actions: ReturnType<typeof planAgentMaintenanceActions>) => actions.map((a) => a.actionClass);

describe("planAgentMaintenanceActions (#778)", () => {
  it("plans nothing for a not-yet-evaluated verdict (neutral / skipped)", () => {
    expect(planAgentMaintenanceActions(input({ conclusion: "neutral", autonomy: { merge: "auto", label: "auto", close: "auto" } }))).toEqual([]);
    expect(planAgentMaintenanceActions(input({ conclusion: "skipped", autonomy: { approve: "auto" } }))).toEqual([]);
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

  it("never emits request_changes even for an action_required verdict (merge-or-close, never block)", () => {
    const plan = classes(planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { request_changes: "auto", close: "auto", label: "auto" }, blockerTitles: [] })));
    expect(plan).not.toContain("request_changes");
    expect(plan).toContain("close"); // contributor + not review-good → close
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

  it("applies conservative defaults when autoMaintain / slopGateMinScore are omitted", () => {
    // no autoMaintain → requireApprovals defaults to 1 → a clean passing PR without APPROVED does NOT merge
    expect(classes(planAgentMaintenanceActions({ conclusion: "success", blockerTitles: [], autonomy: { merge: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], mergeableState: "clean" } }))).not.toContain("merge");
    // no slopGateMinScore → defaults to 60 → slopRisk 70 counts as noise and closes
    expect(classes(planAgentMaintenanceActions({ conclusion: "failure", blockerTitles: ["x"], autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 70 } }))).toContain("close");
    // ...and slopRisk 50 (below the slop default) STILL closes — a failing-gate contributor PR is closed one-shot
    // regardless of slop; the slop score only adds a close reason (minimize-manual: merge-or-close).
    expect(classes(planAgentMaintenanceActions({ conclusion: "failure", blockerTitles: ["x"], autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 50 } }))).toContain("close");
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

    it("does NOT auto-close a failing contributor PR on a guarded path — holds it for the owner (#hold-crucial-on-reject)", () => {
      // Operator decision: a crucial/guarded PR is NEVER auto-closed, even on a reject — a hallucinated reject
      // must not auto-close a good crucial PR (the #1528 near-miss). The owner verifies + closes/merges. The
      // BULK (non-guarded) still auto-closes on reject; only the small crucial set is held.
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], ...guarded, pr: { labels: [], slopRisk: 95 } })));
      expect(plan).not.toContain("close");
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

    it("CLOSES a contributor's gate-passing PR whose CI is UNVERIFIED (fork workflows awaiting approval → green can't be confirmed)", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "unverified", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("approve");
      expect(cls).toContain("close");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_CHANGES);
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
