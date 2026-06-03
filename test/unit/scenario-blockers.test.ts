import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import { buildScorePreview, type ScoreGateBlocker, type ScorePreviewInput } from "../../src/scoring/preview";
import type { ScoringModelSnapshotRecord } from "../../src/types";

// Minimal scoring model snapshot sufficient for gate/blocker tests.
const snapshot: ScoringModelSnapshotRecord = {
  id: "blocker-test-model",
  sourceKind: "test",
  sourceUrl: "fixture://constants.py",
  fetchedAt: "2026-06-03T00:00:00.000Z",
  activeModel: "current_density_model",
  constants: {
    OSS_EMISSION_SHARE: 0.9,
    MERGED_PR_BASE_SCORE: 25,
    MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
    MAX_CODE_DENSITY_MULTIPLIER: 1.15,
    MAX_CONTRIBUTION_BONUS: 25,
    CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
    STANDARD_ISSUE_MULTIPLIER: 1.33,
    MAINTAINER_ISSUE_MULTIPLIER: 1.66,
    MIN_CREDIBILITY: 0.8,
    REVIEW_PENALTY_RATE: 0.15,
    EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
    OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
    MAX_OPEN_PR_THRESHOLD: 30,
    OPEN_PR_COLLATERAL_PERCENT: 0.2,
    SRC_TOK_SATURATION_SCALE: 58,
  },
  programmingLanguages: {},
  registrySnapshotId: "registry-fixture",
  warnings: [],
  payload: {},
};

const registeredRepo = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {} },
};

function preview(input: Partial<ScorePreviewInput> = {}) {
  return buildScorePreview({
    repo: registeredRepo,
    snapshot,
    input: {
      repoFullName: "octo/demo",
      sourceTokenScore: 60,
      totalTokenScore: 80,
      sourceLines: 50,
      openPrCount: 1,
      credibility: 1,
      ...input,
    },
  });
}

function blockerCodes(result: ReturnType<typeof preview>): ScoreGateBlocker["code"][] {
  return result.blockedBy.map((b) => b.code);
}

// ── Stale-work blocker ─────────────────────────────────────────────────────

describe("stale_work scenario blocker", () => {
  it("emits a stale_work reducer blocker when observedStalePrCount is positive", () => {
    const result = preview({ observedStalePrCount: 2 });
    const stale = result.blockedBy.find((b) => b.code === "stale_work");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("reducer");
    expect(stale?.detail).toMatch(/2 stale open PR/i);
  });

  it("does not emit stale_work when observedStalePrCount is zero or absent", () => {
    expect(blockerCodes(preview({ observedStalePrCount: 0 }))).not.toContain("stale_work");
    expect(blockerCodes(preview({}))).not.toContain("stale_work");
  });

  it("emits stale_work in every scenario preview that shares the current blocked-by evaluation", () => {
    const result = preview({ observedStalePrCount: 1 });
    const staleInScenarios = result.scenarioPreviews.filter((s) => s.blockedBy.some((b) => b.code === "stale_work"));
    expect(staleInScenarios.length).toBeGreaterThan(0);
  });

  it("stale_work detail text is free of forbidden public language", () => {
    const result = preview({ observedStalePrCount: 3 });
    const stale = result.blockedBy.find((b) => b.code === "stale_work")!;
    expect(sanitizePublicComment(stale.detail)).not.toMatch(
      /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|scoreability|private reviewability/i,
    );
  });
});

// ── Duplicate-risk blocker ─────────────────────────────────────────────────

describe("duplicate_risk scenario blocker", () => {
  it("emits a duplicate_risk reducer blocker when duplicateRiskCount is positive", () => {
    const result = preview({ duplicateRiskCount: 1 });
    const dup = result.blockedBy.find((b) => b.code === "duplicate_risk");
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe("reducer");
    expect(dup?.detail).toMatch(/1 duplicate-risk/i);
  });

  it("does not emit duplicate_risk when duplicateRiskCount is zero or absent", () => {
    expect(blockerCodes(preview({ duplicateRiskCount: 0 }))).not.toContain("duplicate_risk");
    expect(blockerCodes(preview({}))).not.toContain("duplicate_risk");
  });

  it("emits duplicate_risk with correct count in the detail", () => {
    const result = preview({ duplicateRiskCount: 5 });
    const dup = result.blockedBy.find((b) => b.code === "duplicate_risk")!;
    expect(dup.detail).toMatch(/5 duplicate-risk/i);
  });

  it("duplicate_risk detail text is free of forbidden public language", () => {
    const result = preview({ duplicateRiskCount: 2 });
    const dup = result.blockedBy.find((b) => b.code === "duplicate_risk")!;
    expect(sanitizePublicComment(dup.detail)).not.toMatch(
      /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|scoreability|private reviewability/i,
    );
  });
});

// ── Both blockers together ─────────────────────────────────────────────────

describe("stale_work + duplicate_risk combined", () => {
  it("surfaces both blockers independently when both signals are present", () => {
    const result = preview({ observedStalePrCount: 2, duplicateRiskCount: 3 });
    const codes = blockerCodes(result);
    expect(codes).toContain("stale_work");
    expect(codes).toContain("duplicate_risk");
  });

  it("stale and duplicate blockers appear after existing gate blockers without displacing them", () => {
    const result = preview({ openPrCount: 5, observedStalePrCount: 1, duplicateRiskCount: 1 });
    expect(blockerCodes(result)).toContain("open_pr_threshold");
    expect(blockerCodes(result)).toContain("stale_work");
    expect(blockerCodes(result)).toContain("duplicate_risk");
  });
});

// ── No-blocker fixture ─────────────────────────────────────────────────────

describe("no-blocker baseline", () => {
  it("does not emit stale_work or duplicate_risk when neither signal is present", () => {
    const result = preview();
    expect(blockerCodes(result)).not.toContain("stale_work");
    expect(blockerCodes(result)).not.toContain("duplicate_risk");
  });
});

// ── Public sanitizer tests for evidence summaries ──────────────────────────

describe("blocker detail sanitizer fixtures", () => {
  it("sanitized stale_work detail avoids forbidden language", () => {
    const detail = "3 stale open PR(s) detected; consider closing stale work before opening new contributions.";
    const sanitized = sanitizePublicComment(detail);
    expect(sanitized).not.toMatch(/wallet|hotkey|payout|reward|raw trust|scoreability/i);
    expect(sanitized).toContain("stale");
  });

  it("sanitized duplicate_risk detail avoids forbidden language", () => {
    const detail = "2 duplicate-risk issue(s) or PR(s) detected; verify there is no conflicting work before proceeding.";
    const sanitized = sanitizePublicComment(detail);
    expect(sanitized).not.toMatch(/wallet|hotkey|payout|reward|raw trust|scoreability/i);
    expect(sanitized).toContain("duplicate");
  });

  it("blockedBy array on a scenario preview with both signals is fully sanitizable", () => {
    const result = preview({ observedStalePrCount: 2, duplicateRiskCount: 1 });
    const allDetail = result.blockedBy.map((b) => sanitizePublicComment(b.detail)).join(" ");
    expect(allDetail).not.toMatch(/wallet|hotkey|payout|reward|raw trust|scoreability|private reviewability/i);
  });
});
