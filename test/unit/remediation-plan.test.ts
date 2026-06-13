import { describe, expect, it } from "vitest";
import { buildRemediationPlan } from "../../src/services/remediation-plan";

const FORBIDDEN = /\b(wallet|hotkey|coldkey|mnemonic|farming|payout|raw[-_\s]?trust)\b/i;

describe("buildRemediationPlan", () => {
  it("returns an ordered, deduplicated checklist with rerun conditions", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: ["Open PR count exceeds the current allowance (6/2)."],
      branchQualityBlockers: ["Local validation failed", "GitHub checks need attention"],
      scoreBlockers: ["Local validation failed", "Repo is not registered for Gittensor scoring"],
      recommendedRerunCondition: "Rerun after fixing branch-quality blockers or adding explicit validation/linked-context evidence.",
      localFindings: [
        {
          code: "failed_local_validation",
          severity: "warning",
          title: "Local validation failed",
          detail: "1 validation command failed.",
          action: "Fix validation before asking maintainers to review.",
        },
      ],
    });

    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items[0]?.source).toBe("account_state");
    expect(plan.items[0]?.impact).toBe("high");
    const steps = plan.items.map((item) => item.step);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps[0]).toBe("Open PR count exceeds the current allowance (6/2).");
    expect(steps).toContain("Fix validation before asking maintainers to review.");
    for (const item of plan.items) {
      expect(item.rerunCondition.length).toBeGreaterThan(0);
      expect(item.rank).toBeGreaterThan(0);
    }
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN);
  });

  it("deduplicates overlapping branch-quality and score blockers", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: [],
      branchQualityBlockers: ["Local validation failed", "Local validation failed"],
      scoreBlockers: ["Local validation failed", "GitHub checks need attention"],
      recommendedRerunCondition: "Rerun after fixing branch-quality blockers or adding explicit validation/linked-context evidence.",
      localFindings: [
        {
          code: "failed_local_validation",
          severity: "warning",
          title: "Local validation failed",
          detail: "1 validation command failed.",
          action: "Fix validation before asking maintainers to review.",
        },
      ],
    });

    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]?.step).toBe("Fix validation before asking maintainers to review.");
    expect(plan.items.map((item) => item.step)).toEqual(["Fix validation before asking maintainers to review.", "GitHub checks need attention"]);
  });

  it("returns a public-safe empty-state plan when no blockers are present", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      branchQualityBlockers: [],
      accountStateBlockers: [],
      scoreBlockers: [],
      recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
    });

    expect(plan.items).toEqual([]);
    expect(plan.summary).toMatch(/No blockers detected/i);
    expect(plan.recommendedRerunCondition).toMatch(/branch, base, or PR state changes/i);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN);
  });

  it("sanitizes scoreability language from rerun conditions", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: [],
      branchQualityBlockers: ["Branch eligibility blocks linked-issue assumptions"],
      scoreBlockers: [],
      recommendedRerunCondition: "Rerun after branch/base eligibility metadata confirms eligibility or after linked issue assumptions change.",
    });

    expect(plan.recommendedRerunCondition).toMatch(/linked issue and base branch metadata/i);
    expect(plan.recommendedRerunCondition).not.toMatch(/scoreability|multiplier/i);
  });

  it("maps blocker-specific rerun conditions and fallback steps", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: ["Open PR count exceeds threshold", "Contributor credibility history is still maturing"],
      branchQualityBlockers: ["Local branch base is stale", "Linked issue is duplicate-prone", "GitHub checks need attention"],
      scoreBlockers: ["wallet hotkey payout"],
      recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
    });

    expect(plan.items.find((item) => item.source === "account_state" && /Open PR/i.test(item.step))?.rerunCondition).toMatch(/pending PRs merge\/close/i);
    expect(plan.items.find((item) => /maturing/i.test(item.step))?.rerunCondition).toMatch(/account\/queue maturity blockers clear/i);
    expect(plan.items.find((item) => /stale/i.test(item.step))?.rerunCondition).toMatch(/git fetch origin/i);
    expect(plan.items.find((item) => /duplicate-prone/i.test(item.step))?.rerunCondition).toMatch(/linked issue and base branch metadata/i);
    expect(plan.items.find((item) => /GitHub checks/i.test(item.step))?.rerunCondition).toMatch(/validation evidence/i);
    expect(plan.items.find((item) => item.source === "score")?.step).toBe("Resolve scoreability blockers before relying on this preview.");
    expect(JSON.stringify(plan)).not.toMatch(/\bwallet\b|\bhotkey\b|\bpayout\b/i);
  });

  it("covers fallback rerun and step branches for sanitized-only input", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: ["Repository allocation is inactive"],
      branchQualityBlockers: ["wallet hotkey payout"],
      scoreBlockers: [""],
      recommendedRerunCondition: "scoreability multiplier eligibility score preview",
    });

    expect(plan.items.find((item) => item.source === "account_state")?.step).toBe("Repository allocation is inactive");
    expect(plan.items.find((item) => item.source === "branch_quality")?.step).toBe("Resolve branch-quality findings before submission.");
    expect(plan.recommendedRerunCondition).toMatch(/linked issue and base branch metadata/i);
    expect(plan.summary).toMatch(/2 remediation step/i);
  });

  it("falls back when recommended rerun text is fully redacted", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: [],
      branchQualityBlockers: ["Needs cleanup"],
      scoreBlockers: [],
      recommendedRerunCondition: "wallet hotkey payout reward farming",
    });

    expect(plan.recommendedRerunCondition).toMatch(/branch, base, or PR state changes/i);
  });

  it("uses account-state fallback copy when a blocker is fully redacted", () => {
    const plan = buildRemediationPlan({
      login: "miner",
      repoFullName: "octo/demo",
      accountStateBlockers: ["wallet hotkey payout"],
      branchQualityBlockers: [],
      scoreBlockers: ["reward farming score preview"],
      recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        source: "account_state",
        step: "Clear account or queue maturity blockers before opening more work.",
      }),
      expect.objectContaining({
        source: "score",
        step: "Resolve scoreability blockers before relying on this preview.",
      }),
    ]);
  });
});
