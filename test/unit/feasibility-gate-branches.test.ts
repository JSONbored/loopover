import { describe, expect, it } from "vitest";
import {
  buildFeasibilityVerdict,
  feasibilityInputFromPreStartCheck,
  type FeasibilityClaimStatus,
  type FeasibilityDuplicateClusterRisk,
  type FeasibilityGateInput,
  type FeasibilityIssueStatus,
} from "../../packages/gittensory-engine/src/feasibility";
import { buildPreStartCheck } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

// Record builders mirror test/unit/signals-coverage.test.ts so parity cases reuse the same fixture shape.
function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 1,
      labelMultipliers: {},
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "Detailed issue body with reproduction steps and expected behavior.",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [],
    body: "",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseInput(over: Partial<FeasibilityGateInput> = {}): FeasibilityGateInput {
  return {
    claimStatus: "unclaimed",
    duplicateClusterRisk: "none",
    issueStatus: "ready",
    ...over,
  };
}

const CLAIM_STATUSES: FeasibilityClaimStatus[] = ["unclaimed", "claimed", "solved", "unknown"];
const DUPLICATE_RISKS: FeasibilityDuplicateClusterRisk[] = ["none", "low", "medium", "high"];
const ISSUE_STATUSES: FeasibilityIssueStatus[] = ["ready", "needs_proof", "hold", "do_not_use", "duplicate", "invalid", "missing"];

describe("buildFeasibilityVerdict branch coverage (#2313)", () => {
  it("resolves the all-clear happy path to go", () => {
    const result = buildFeasibilityVerdict(baseInput());
    expect(result.verdict).toBe("go");
    expect(result.avoidReasons).toEqual([]);
    expect(result.raiseReasons).toEqual([]);
    expect(result.summary).toMatch(/^Go:/);
  });

  it("records TWO simultaneous avoid triggers instead of collapsing them with ??/||", () => {
    const result = buildFeasibilityVerdict(
      baseInput({ claimStatus: "solved", duplicateClusterRisk: "high", issueStatus: "duplicate" }),
    );
    expect(result.verdict).toBe("avoid");
    expect(result.avoidReasons).toEqual(
      expect.arrayContaining(["claim_status_solved", "duplicate_cluster_high", "issue_lifecycle_duplicate"]),
    );
    expect(result.avoidReasons.length).toBe(3);
  });

  it.each([
    { claimStatus: "solved" as const, reason: "claim_status_solved" },
    { issueStatus: "do_not_use" as const, reason: "issue_quality_do_not_use" },
    { issueStatus: "duplicate" as const, reason: "issue_lifecycle_duplicate" },
    { issueStatus: "invalid" as const, reason: "issue_lifecycle_invalid" },
    { duplicateClusterRisk: "high" as const, reason: "duplicate_cluster_high" },
  ])("avoid when $reason fires alone", ({ reason, ...over }) => {
    const result = buildFeasibilityVerdict(baseInput(over));
    expect(result.verdict).toBe("avoid");
    expect(result.avoidReasons).toEqual([reason]);
  });

  it.each([
    { found: false, reason: "target_not_found" },
    { duplicateClusterRisk: "medium" as const, reason: "duplicate_cluster_medium" },
    { claimStatus: "claimed" as const, reason: "claim_status_claimed" },
    { issueStatus: "needs_proof" as const, reason: "issue_quality_uncertain" },
    { issueStatus: "hold" as const, reason: "issue_quality_uncertain" },
    { issueStatus: "missing" as const, reason: "issue_missing" },
  ])("raise when $reason fires alone", ({ reason, ...over }) => {
    const result = buildFeasibilityVerdict(baseInput(over));
    expect(result.verdict).toBe("raise");
    expect(result.raiseReasons).toEqual([reason]);
  });

  it("prefers avoid over raise when both classes would fire", () => {
    const result = buildFeasibilityVerdict(
      baseInput({ claimStatus: "claimed", duplicateClusterRisk: "high", issueStatus: "ready" }),
    );
    expect(result.verdict).toBe("avoid");
    expect(result.avoidReasons).toEqual(["duplicate_cluster_high"]);
    expect(result.raiseReasons).toEqual([]);
  });

  it.each([
    { claimStatus: "unknown" as const, duplicateClusterRisk: "low" as const, issueStatus: "ready" as const, expected: "go" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "low" as const, issueStatus: "ready" as const, expected: "go" },
    { claimStatus: "claimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "ready" as const, expected: "raise" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "medium" as const, issueStatus: "ready" as const, expected: "raise" },
    { claimStatus: "solved" as const, duplicateClusterRisk: "none" as const, issueStatus: "ready" as const, expected: "avoid" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "do_not_use" as const, expected: "avoid" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "duplicate" as const, expected: "avoid" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "invalid" as const, expected: "avoid" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "high" as const, issueStatus: "ready" as const, expected: "avoid" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "needs_proof" as const, expected: "raise" },
    { claimStatus: "unclaimed" as const, duplicateClusterRisk: "none" as const, issueStatus: "missing" as const, expected: "raise", found: false },
  ] as Array<Partial<FeasibilityGateInput> & { expected: "go" | "raise" | "avoid" }>)(
    "branches claim=$claimStatus dup=$duplicateClusterRisk issue=$issueStatus → $expected",
    ({ expected, ...input }) => {
      expect(buildFeasibilityVerdict(baseInput(input)).verdict).toBe(expected);
    },
  );

  it("exercises every claimStatus value against a neutral duplicate/issue baseline", () => {
    for (const claimStatus of CLAIM_STATUSES) {
      const verdict = buildFeasibilityVerdict(baseInput({ claimStatus })).verdict;
      if (claimStatus === "solved") expect(verdict).toBe("avoid");
      else if (claimStatus === "claimed") expect(verdict).toBe("raise");
      else expect(verdict).toBe("go");
    }
  });

  it("exercises every duplicateClusterRisk value against a neutral claim/issue baseline", () => {
    for (const duplicateClusterRisk of DUPLICATE_RISKS) {
      const verdict = buildFeasibilityVerdict(baseInput({ duplicateClusterRisk })).verdict;
      if (duplicateClusterRisk === "high") expect(verdict).toBe("avoid");
      else if (duplicateClusterRisk === "medium") expect(verdict).toBe("raise");
      else expect(verdict).toBe("go");
    }
  });

  it("exercises every issueStatus value against a neutral claim/duplicate baseline", () => {
    for (const issueStatus of ISSUE_STATUSES) {
      const verdict = buildFeasibilityVerdict(baseInput({ issueStatus, found: issueStatus === "missing" ? false : true })).verdict;
      if (issueStatus === "do_not_use" || issueStatus === "duplicate" || issueStatus === "invalid") expect(verdict).toBe("avoid");
      else if (issueStatus === "needs_proof" || issueStatus === "hold" || issueStatus === "missing") expect(verdict).toBe("raise");
      else expect(verdict).toBe("go");
    }
  });

  it("matches buildPreStartCheck recommendations on issue-discovery repos (parity via mapped inputs)", () => {
    const repository = repo("owner/repo", { issueDiscoveryShare: 1 });
    const scenarios = [
      {
        report: buildPreStartCheck(repository, [issue("owner/repo", 1, "Fix parser crash on empty input handling")], [], [], "owner/repo", {
          issueNumber: 1,
        }),
      },
      {
        report: buildPreStartCheck(
          repository,
          [issue("owner/repo", 1, "Fix parser crash on empty input handling")],
          [pr("owner/repo", 10, "Fix parser crash", { linkedIssues: [1] })],
          [],
          "owner/repo",
          { issueNumber: 1 },
        ),
      },
      {
        report: buildPreStartCheck(
          repository,
          [issue("owner/repo", 3, "Add pagination to the labels endpoint")],
          [
            pr("owner/repo", 31, "Paginate labels", { linkedIssues: [3] }),
            pr("owner/repo", 32, "Labels pagination", { linkedIssues: [3] }),
          ],
          [],
          "owner/repo",
          { issueNumber: 3 },
        ),
      },
      {
        report: buildPreStartCheck(
          repository,
          [issue("owner/repo", 6, "Something is broken somewhere", { body: "broken" })],
          [],
          [],
          "owner/repo",
          { issueNumber: 6 },
        ),
      },
      {
        report: buildPreStartCheck(repository, [issue("owner/repo", 1, "Real issue")], [], [], "owner/repo", { issueNumber: 999 }),
      },
    ];

    for (const { report } of scenarios) {
      const mapped = feasibilityInputFromPreStartCheck(report);
      expect(buildFeasibilityVerdict(mapped).verdict).toBe(report.recommendation);
    }
  });
});

describe("feasibilityInputFromPreStartCheck mapping (#2313)", () => {
  function report(over: Partial<Parameters<typeof feasibilityInputFromPreStartCheck>[0]> = {}) {
    return {
      found: true,
      claimStatus: "unclaimed" as const,
      duplicateClusterRisk: "none" as const,
      ...over,
    };
  }

  it("maps a not-found target to issueStatus 'missing', regardless of lifecycle/quality", () => {
    expect(feasibilityInputFromPreStartCheck(report({ found: false })).issueStatus).toBe("missing");
  });

  it("maps lifecycle 'duplicate' to issueStatus 'duplicate' ahead of any quality status", () => {
    expect(feasibilityInputFromPreStartCheck(report({ lifecycle: "duplicate", issueQualityStatus: "hold" })).issueStatus).toBe("duplicate");
  });

  it("maps lifecycle 'invalid' to issueStatus 'invalid' ahead of any quality status", () => {
    expect(feasibilityInputFromPreStartCheck(report({ lifecycle: "invalid", issueQualityStatus: "do_not_use" })).issueStatus).toBe("invalid");
  });

  it("maps issueQualityStatus 'do_not_use' to issueStatus 'do_not_use'", () => {
    expect(feasibilityInputFromPreStartCheck(report({ issueQualityStatus: "do_not_use" })).issueStatus).toBe("do_not_use");
  });

  it("maps issueQualityStatus 'needs_proof' to issueStatus 'needs_proof'", () => {
    expect(feasibilityInputFromPreStartCheck(report({ issueQualityStatus: "needs_proof" })).issueStatus).toBe("needs_proof");
  });

  it("maps issueQualityStatus 'hold' to issueStatus 'hold'", () => {
    expect(feasibilityInputFromPreStartCheck(report({ issueQualityStatus: "hold" })).issueStatus).toBe("hold");
  });

  it("defaults to issueStatus 'ready' when found and no lifecycle/quality signal fires", () => {
    expect(feasibilityInputFromPreStartCheck(report()).issueStatus).toBe("ready");
  });

  it("passes claimStatus and duplicateClusterRisk through unchanged", () => {
    const mapped = feasibilityInputFromPreStartCheck(report({ claimStatus: "claimed", duplicateClusterRisk: "high" }));
    expect(mapped.claimStatus).toBe("claimed");
    expect(mapped.duplicateClusterRisk).toBe("high");
    expect(mapped.found).toBe(true);
  });
});
