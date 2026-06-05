import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import { buildScorePreview, type ScorePreviewInput } from "../../src/scoring/preview";
import { deriveEligibilityPlan } from "../../src/services/eligibility-plan";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../../src/services/open-pr-pressure-scenarios";
import { buildScenarioInput, createScenarioSignalEntry } from "../../src/scenarios/input-model";
import { renderPublicScenarioSummary, type ScenarioSummaryInput } from "../../src/scenarios/scenario-summary";
import type { QueueHealth, RoleContext } from "../../src/signals/engine";
import type { ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

// ── Shared fixtures ────────────────────────────────────────────────────────

const snapshot: ScoringModelSnapshotRecord = {
  id: "summary-test-model",
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

const repo = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {} },
};

function queueHealth(level: QueueHealth["level"], overrides: Partial<QueueHealth["signals"]> = {}): QueueHealth {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    burdenScore: level === "low" ? 10 : level === "medium" ? 40 : level === "high" ? 65 : 90,
    level,
    summary: `Queue is ${level}.`,
    signals: {
      openIssues: 5,
      openPullRequests: level === "low" ? 1 : 12,
      unlinkedPullRequests: 0,
      stalePullRequests: level === "high" || level === "critical" ? 4 : 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 1, days7To30: 0, over30Days: 0 },
      likelyReviewablePullRequests: 1,
      ...overrides,
    },
    findings: [],
  };
}

function roleContext(maintainerLane: boolean): RoleContext {
  return {
    login: "miner-a",
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    role: maintainerLane ? "owner" : "outside_contributor",
    maintainerLane,
    normalContributorEvidenceAllowed: !maintainerLane,
    source: maintainerLane ? "repo_owner_match" : "cache",
    association: maintainerLane ? "OWNER" : "NONE",
    reasons: [],
    guidance: maintainerLane ? "maintainer" : "contributor",
  };
}

function pressureInput(overrides: Partial<OpenPrPressureInput> = {}): OpenPrPressureInput {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    queueHealth: queueHealth("low"),
    roleContext: roleContext(false),
    contributorOpenPrCount: 0,
    ...overrides,
  };
}

function previewResult(input: Partial<ScorePreviewInput> = {}) {
  return buildScorePreview({
    repo,
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

function baseSummaryInput(overrides: Partial<ScenarioSummaryInput> = {}): ScenarioSummaryInput {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

// ── Public summary structure ───────────────────────────────────────────────

describe("renderPublicScenarioSummary — structure", () => {
  it("always includes advisory-only flags", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.advisoryOnly).toBe(true);
    expect(summary.notAutonomousPrBot).toBe(true);
    expect(summary.notPublicScoring).toBe(true);
  });

  it("passes through repoFullName and generatedAt unchanged", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.repoFullName).toBe("octo/demo");
    expect(summary.generatedAt).toBe("2026-06-03T00:00:00.000Z");
  });

  it("returns empty options when no pressure simulation is provided", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.options).toHaveLength(0);
  });

  it("returns empty eligibilityNotes when no eligibility plan is provided", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.eligibilityNotes).toHaveLength(0);
  });

  it("returns empty blockerNotes when no blockers are provided", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.blockerNotes).toHaveLength(0);
  });

  it("returns empty dataClassification when no scenarioInput is provided", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.dataClassification).toEqual({ facts: [], assumptions: [], unavailableSignals: [] });
  });

  it("emits a fallback headline when neither simulation nor eligibility plan is provided", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.headline.length).toBeGreaterThan(0);
    expect(summary.headline).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

// ── Snapshot: open-PR pressure simulation ────────────────────────────────

describe("renderPublicScenarioSummary — open-PR pressure simulation", () => {
  it("renders ranked options from a low-pressure contributor simulation", () => {
    const simulation = simulateOpenPrPressure(pressureInput({ queueHealth: queueHealth("low"), contributorOpenPrCount: 0 }));
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));

    expect(summary.options).toHaveLength(3);
    expect(summary.options.map((o) => o.rank)).toEqual([1, 2, 3]);
    expect(summary.options[0]).toMatchObject({
      rank: 1,
      recommended: true,
    });
    expect(summary.options[0]!.label.length).toBeGreaterThan(0);
    expect(summary.options[0]!.rationale.length).toBeGreaterThan(0);
    expect(summary.options[0]!.nextStep.length).toBeGreaterThan(0);
  });

  it("uses the simulation summary as the headline", () => {
    const simulation = simulateOpenPrPressure(pressureInput({ queueHealth: queueHealth("low"), contributorOpenPrCount: 0 }));
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));
    expect(summary.headline).toBe(simulation.summary);
  });

  it("renders ranked options from a high-pressure contributor simulation with open PRs", () => {
    const simulation = simulateOpenPrPressure(pressureInput({ queueHealth: queueHealth("critical"), contributorOpenPrCount: 2 }));
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));

    const top = summary.options[0]!;
    expect(top.recommended).toBe(true);
    expect(top.obstacles.length + top.assumptions.length).toBeGreaterThan(0);
  });

  it("renders ranked options for a maintainer-lane simulation", () => {
    const simulation = simulateOpenPrPressure(
      pressureInput({ queueHealth: queueHealth("medium"), roleContext: roleContext(true), contributorOpenPrCount: 1 }),
    );
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));
    expect(summary.options).toHaveLength(3);
    expect(summary.options[0]!.recommended).toBe(true);
  });

  it("renders ranked options when queue signals are missing", () => {
    const simulation = simulateOpenPrPressure(pressureInput({ queueHealth: null, contributorOpenPrCount: 0 }));
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));
    expect(summary.options).toHaveLength(3);
    expect(summary.headline).toMatch(/unavailable|conservative/i);
  });
});

// ── Snapshot: eligibility plan ─────────────────────────────────────────────

describe("renderPublicScenarioSummary — eligibility plan", () => {
  it("uses eligibility plan summary as headline when no pressure simulation is present", () => {
    const result = previewResult({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [42], solvedByPullRequests: [] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
    });
    const plan = deriveEligibilityPlan(result);
    const summary = renderPublicScenarioSummary(baseSummaryInput({ eligibilityPlan: plan }));
    expect(summary.headline).toBe(plan.publicSummary);
    expect(summary.eligibilityNotes).toContain(plan.publicSummary);
  });

  it("surfaces eligibility blockers in eligibilityNotes", () => {
    const result = previewResult({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "invalid", source: "official_mirror", issueNumbers: [99] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
    });
    const plan = deriveEligibilityPlan(result);
    const summary = renderPublicScenarioSummary(baseSummaryInput({ eligibilityPlan: plan }));
    const notesText = summary.eligibilityNotes.join(" ");
    expect(notesText).toMatch(/invalid|no longer open|verify/i);
    expect(notesText).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("includes cleanup paths in eligibilityNotes when present", () => {
    const result = previewResult({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [77] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
    });
    const plan = deriveEligibilityPlan(result);
    const summary = renderPublicScenarioSummary(baseSummaryInput({ eligibilityPlan: plan }));
    expect(plan.cleanupPaths.length).toBeGreaterThan(0);
    expect(summary.eligibilityNotes.some((n) => n.match(/solved-by-PR|validate|evidence/i))).toBe(true);
  });

  it("includes linked issue projection in eligibilityNotes when available", () => {
    const result = previewResult({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [77] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
    });
    const plan = deriveEligibilityPlan(result);
    if (plan.linkedIssueProjection) {
      const summary = renderPublicScenarioSummary(baseSummaryInput({ eligibilityPlan: plan }));
      expect(summary.eligibilityNotes.join(" ")).toMatch(/linked.issue|contribution consideration/i);
    }
  });
});

// ── Snapshot: blocker notes ────────────────────────────────────────────────

describe("renderPublicScenarioSummary — blocker notes", () => {
  it("surfaces open_pr_threshold and stale_work blockers as human-readable notes", () => {
    const result = previewResult({ openPrCount: 5, observedStalePrCount: 2 });
    const summary = renderPublicScenarioSummary(baseSummaryInput({ publicBlockers: result.blockedBy }));
    const notes = summary.blockerNotes.join(" ");
    expect(notes).toMatch(/too many.*open PR|open PR.*exist|land|close/i);
    expect(notes).toMatch(/stale/i);
  });

  it("includes duplicate_risk note when the blocker is present", () => {
    const result = previewResult({ duplicateRiskCount: 2 });
    const summary = renderPublicScenarioSummary(baseSummaryInput({ publicBlockers: result.blockedBy }));
    expect(summary.blockerNotes.join(" ")).toMatch(/duplicate|conflicting/i);
  });

  it("excludes repo_not_registered and inactive_allocation from public blocker notes", () => {
    const unregisteredRepo = { ...repo, isRegistered: false };
    const result = buildScorePreview({ repo: unregisteredRepo, snapshot, input: { repoFullName: "octo/demo", sourceTokenScore: 0 } });
    const summary = renderPublicScenarioSummary(baseSummaryInput({ publicBlockers: result.blockedBy }));
    const notes = summary.blockerNotes.join(" ");
    expect(notes).not.toMatch(/not registered|no active allocation/i);
  });

  it("blocker notes are empty when no blockers are present", () => {
    const result = previewResult({ openPrCount: 1, credibility: 1 });
    const cleanBlockers = result.blockedBy.filter((b) => b.severity === "blocker");
    const summary = renderPublicScenarioSummary(baseSummaryInput({ publicBlockers: cleanBlockers }));
    expect(summary.blockerNotes).toHaveLength(0);
  });
});

// ── Snapshot: data classification from scenario input ─────────────────────

describe("renderPublicScenarioSummary — data classification", () => {
  it("populates facts, assumptions, and unavailableSignals labels from a scenario input", () => {
    const input = buildScenarioInput({
      scenarioType: "branch_preflight",
      repoFullName: "octo/demo",
      facts: [
        createScenarioSignalEntry({ id: "queue", kind: "fact", label: "Queue signals", detail: "Two open PRs.", source: "github_observed" }),
      ],
      assumptions: [
        createScenarioSignalEntry({ id: "pending", kind: "assumption", label: "Pending merges", detail: "One approved PR.", source: "user_supplied" }),
      ],
      unavailableSignals: [
        createScenarioSignalEntry({ id: "stats", kind: "unavailable", label: "Official stats", detail: "Not available.", source: "missing" }),
      ],
    });
    const summary = renderPublicScenarioSummary(baseSummaryInput({ scenarioInput: input }));
    expect(summary.dataClassification.facts).toContain("Queue signals");
    expect(summary.dataClassification.assumptions).toContain("Pending merges");
    expect(summary.dataClassification.unavailableSignals).toContain("Official stats");
  });

  it("does not include estimates bucket in the public data classification", () => {
    const summary = renderPublicScenarioSummary(baseSummaryInput());
    expect(summary.dataClassification).not.toHaveProperty("estimates");
  });
});

// ── Combined snapshot: pressure + eligibility + blockers ──────────────────

describe("renderPublicScenarioSummary — combined inputs", () => {
  it("combines pressure headline, options, eligibility notes, and blocker notes correctly", () => {
    const simulation = simulateOpenPrPressure(
      pressureInput({ queueHealth: queueHealth("high"), contributorOpenPrCount: 1 }),
    );
    const result = previewResult({
      openPrCount: 1,
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [5] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
      observedStalePrCount: 1,
    });
    const plan = deriveEligibilityPlan(result);
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pressureSimulation: simulation,
      eligibilityPlan: plan,
      publicBlockers: result.blockedBy,
    });

    expect(summary.options.length).toBeGreaterThan(0);
    expect(summary.eligibilityNotes.length).toBeGreaterThan(0);
    expect(summary.blockerNotes.length).toBeGreaterThan(0);
    expect(summary.headline).toBe(simulation.summary);
  });
});

// ── Sanitizer fixtures: restricted terminology ────────────────────────────

describe("sanitizer fixtures for restricted terminology", () => {
  it("all text fields across a full-signal summary pass the forbidden-language check", () => {
    const simulation = simulateOpenPrPressure(
      pressureInput({ queueHealth: queueHealth("high"), contributorOpenPrCount: 2 }),
    );
    const result = previewResult({
      openPrCount: 2,
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [7] },
      branchEligibility: { status: "eligible", source: "github_metadata" },
      observedStalePrCount: 1,
      duplicateRiskCount: 1,
    });
    const plan = deriveEligibilityPlan(result);
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pressureSimulation: simulation,
      eligibilityPlan: plan,
      publicBlockers: result.blockedBy,
    });

    const allText = JSON.stringify(summary);
    expect(allText).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("all text fields are unchanged by a second pass of sanitizePublicComment", () => {
    const simulation = simulateOpenPrPressure(pressureInput());
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));
    const textFields = [
      summary.headline,
      ...summary.options.flatMap((o) => [o.label, o.rationale, o.nextStep, ...o.obstacles, ...o.assumptions]),
      ...summary.eligibilityNotes,
      ...summary.blockerNotes,
    ];
    for (const field of textFields) {
      expect(field).toBe(sanitizePublicComment(field));
    }
  });

  it("does not expose score, reward, or private context in any fixture variant", () => {
    const fixtures: ScenarioSummaryInput[] = [
      baseSummaryInput(),
      baseSummaryInput({ pressureSimulation: simulateOpenPrPressure(pressureInput({ queueHealth: queueHealth("critical"), contributorOpenPrCount: 3 })) }),
      baseSummaryInput({ pressureSimulation: simulateOpenPrPressure(pressureInput({ queueHealth: null })) }),
      baseSummaryInput({ eligibilityPlan: deriveEligibilityPlan(previewResult({ linkedIssueMode: "none" })) }),
      baseSummaryInput({ publicBlockers: previewResult({ observedStalePrCount: 2, duplicateRiskCount: 1 }).blockedBy }),
    ];
    for (const fixture of fixtures) {
      const summary = renderPublicScenarioSummary(fixture);
      expect(JSON.stringify(summary)).not.toMatch(/\bscore\b|reward|earn|payout|hotkey|wallet|trust score|scoreability/i);
    }
  });

  it("makes no claim about autonomous PR filing, issue creation, or merge actions", () => {
    const simulation = simulateOpenPrPressure(pressureInput({ queueHealth: queueHealth("medium"), contributorOpenPrCount: 1 }));
    const summary = renderPublicScenarioSummary(baseSummaryInput({ pressureSimulation: simulation }));
    const allText = JSON.stringify(summary);
    expect(allText).not.toMatch(/will open|will merge|will close|will file|automatically|autonomously/i);
  });
});

// ── Advisory-only invariants ───────────────────────────────────────────────

describe("advisory-only invariants", () => {
  it("advisory flags are present and set to true in all fixture variants", () => {
    const fixtures: ScenarioSummaryInput[] = [
      baseSummaryInput(),
      baseSummaryInput({ pressureSimulation: simulateOpenPrPressure(pressureInput()) }),
      baseSummaryInput({ eligibilityPlan: deriveEligibilityPlan(previewResult()) }),
    ];
    for (const fixture of fixtures) {
      const summary = renderPublicScenarioSummary(fixture);
      expect(summary.advisoryOnly).toBe(true);
      expect(summary.notAutonomousPrBot).toBe(true);
      expect(summary.notPublicScoring).toBe(true);
    }
  });
});
