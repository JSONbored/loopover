import { describe, expect, it } from "vitest";
import { AGENT_LABEL_CHANGES, AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, isProtectedAutomationAuthor, planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
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

  it("requests changes on a blocking verdict, with the blocker titles in the body, and never double-requests", () => {
    const plan = planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { request_changes: "auto" }, blockerTitles: ["Missing linked issue", "Slop risk"] }));
    const rc = plan.find((a) => a.actionClass === "request_changes");
    expect(rc?.reviewBody).toContain("Missing linked issue");
    expect(rc?.reviewBody).toContain("Slop risk");
    // already in CHANGES_REQUESTED → not re-requested
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { request_changes: "auto" }, blockerTitles: ["x"], pr: { labels: [], reviewDecision: "CHANGES_REQUESTED" } })))).not.toContain("request_changes");
  });

  it("falls back to a generic request-changes body when no blocker titles are supplied", () => {
    const rc = planAgentMaintenanceActions(input({ conclusion: "action_required", autonomy: { request_changes: "auto" }, blockerTitles: [] })).find((a) => a.actionClass === "request_changes");
    expect(rc?.reviewBody).toContain("The Gittensory Gate is not satisfied");
    expect(rc?.reason).toBe("1 blocker(s)");
  });

  it("approves a passing verdict and never re-approves; never approves AND requests changes", () => {
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" } })))).toContain("approve");
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" }, pr: { labels: [], reviewDecision: "APPROVED" } })))).not.toContain("approve");
    // a passing verdict never yields request_changes; a failing one never yields approve
    const failing = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { approve: "auto", request_changes: "auto" }, blockerTitles: ["x"] })));
    expect(failing).toContain("request_changes");
    expect(failing).not.toContain("approve");
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
    // ...and slopRisk 50 is below the default → no close
    expect(classes(planAgentMaintenanceActions({ conclusion: "failure", blockerTitles: ["x"], autonomy: { close: "auto" }, changedPaths: [], hardGuardrailGlobs: [], authorIsOwner: false, authorIsAutomationBot: false, ciState: "passed", pr: { labels: [], slopRisk: 50 } }))).not.toContain("close");
  });

  it("closes clear noise (high slop or duplicate) on a non-passing verdict, and never closes a passing PR", () => {
    // high slop
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], slopGateMinScore: 60, pr: { labels: [], slopRisk: 80 } })))).toContain("close");
    // duplicate
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], linkedDuplicateCount: 2 } })))).toContain("close");
    // no noise → no close
    expect(classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], pr: { labels: [], slopRisk: 10 } })))).not.toContain("close");
    // passing verdict is never closed even with noise present
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

    it("does NOT auto-close a noisy failing PR that touches a guarded path", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], ...guarded, pr: { labels: [], slopRisk: 95 } })));
      expect(plan).not.toContain("close");
    });

    it("does NOT auto-approve a passing PR that touches a guarded path (so it can't later satisfy a merge)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" }, ...guarded, pr: { labels: [] } })));
      expect(plan).not.toContain("approve");
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

    it("fails SAFE on UNKNOWN paths: with guardrails configured but no changed-file set, suppress merge/close/approve", () => {
      // The changed-file cache can be empty (fresh PR before backfill) or stale; we cannot prove the PR
      // doesn't touch a guarded path, so it must fall through to a human (label/request_changes still run).
      const merge = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto", label: "auto" }, changedPaths: [], hardGuardrailGlobs: ["src/scoring/**", "scripts/**"], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(merge).not.toContain("merge");
      expect(merge).toContain("label");
      const close = classes(planAgentMaintenanceActions(input({ conclusion: "failure", autonomy: { close: "auto" }, blockerTitles: ["x"], changedPaths: [], hardGuardrailGlobs: ["src/scoring/**"], pr: { labels: [], slopRisk: 95 } })));
      expect(close).not.toContain("close");
      const approve = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto" }, changedPaths: [], hardGuardrailGlobs: ["src/scoring/**"], pr: { labels: [] } })));
      expect(approve).not.toContain("approve");
    });

    it("stays permissive on empty paths when the repo has NO guardrails configured (opted out)", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { merge: "auto" }, changedPaths: [], hardGuardrailGlobs: [], pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } })));
      expect(plan).toContain("merge");
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

    it("NEVER closes the owner's red-CI PR — it is held (request_changes), left open", () => {
      const plan = classes(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { close: "auto", request_changes: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], authorIsOwner: true, pr: { labels: [] } })));
      expect(plan).not.toContain("close");
      expect(plan).toContain("request_changes");
    });

    it("requests changes (never approves) on a red CI and cites the failing check", () => {
      const rc = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { approve: "auto", request_changes: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch", "build"], pr: { labels: [] } })).find((a) => a.actionClass === "request_changes");
      expect(rc?.reviewBody).toContain("codecov/patch");
      expect(rc?.reviewBody).toContain("CI is not green");
    });

    it("labels a red-CI PR changes-requested (not ready-to-merge)", () => {
      const label = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto" }, ciState: "failed", failingCheckNames: ["codecov/patch"], pr: { labels: [] } })).find((a) => a.actionClass === "label");
      expect(label?.label).toBe(AGENT_LABEL_CHANGES);
    });

    it("DEFERS every action while CI is still pending (settle-before-decide)", () => {
      expect(planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "pending", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }))).toEqual([]);
    });

    it("HOLDS (needs-human-review, no merge/close/approve) a gate-passing PR whose CI is unverified", () => {
      const plan = planAgentMaintenanceActions(input({ conclusion: "success", autonomy: { label: "auto", approve: "auto", merge: "auto", close: "auto" }, ciState: "unverified", pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } }));
      const cls = classes(plan);
      expect(cls).not.toContain("merge");
      expect(cls).not.toContain("close");
      expect(cls).not.toContain("approve");
      expect(plan.find((a) => a.actionClass === "label")?.label).toBe(AGENT_LABEL_NEEDS_REVIEW);
    });

    it("merges the same clean+approved PR on green CI but NOT on red CI", () => {
      const base = { conclusion: "success" as const, autonomy: { merge: "auto" as const }, pr: { labels: [], mergeableState: "clean", reviewDecision: "APPROVED" } };
      expect(classes(planAgentMaintenanceActions(input({ ...base, ciState: "passed" })))).toContain("merge");
      expect(classes(planAgentMaintenanceActions(input({ ...base, ciState: "failed" })))).not.toContain("merge");
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
