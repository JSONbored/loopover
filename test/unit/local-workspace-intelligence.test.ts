import { describe, expect, it } from "vitest";
import { buildLocalWorkspaceIntelligence } from "../../src/signals/local-workspace-intelligence";
import { MAX_LOCAL_SCORER_WARNING_CHARS, MAX_LOCAL_SCORER_WARNING_COUNT } from "../../src/signals/local-scorer-diagnostics";
import { hasLocalTestEvidence, isTestPath } from "../../src/signals/test-evidence";
import { buildLocalDiffPreflightResult } from "../../src/signals/engine";
import type { RepositoryRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  defaultBranch: "main",
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01,
    issueDiscoveryShare: 0,
    labelMultipliers: {},
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

describe("local workspace intelligence v2", () => {
  it("summarizes renamed, binary, and deleted files without uploading source", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "asset-cleanup",
        baseRef: "origin/main",
        pendingCommitCount: 2,
        ciStatusHints: ["Workflow files changed; CI required-check behavior may change after merge."],
        changedFiles: [
          { path: "assets/logo.bin", status: "modified", binary: true },
          { path: "src/old.ts", status: "deleted" },
          { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
        ],
      },
      analysis: {
        baseFreshness: {
          status: "fresh",
          changedFileCount: 3,
          testFileCount: 0,
          passedValidationCount: 0,
          warnings: [],
        },
        branchQualityBlockers: [],
        accountStateBlockers: ["Open PR count is high."],
        recommendedRerunCondition: "Rerun after account/queue maturity blockers clear.",
        prPacket: {
          titleSuggestion: "Asset cleanup",
          markdown: "# Asset cleanup\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [
        { path: "assets/logo.bin", status: "modified", binary: true },
        { path: "src/old.ts", status: "deleted" },
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      ],
    });

    expect(intelligence.sourceUpload.enabled).toBe(false);
    expect(intelligence.changedFiles).toMatchObject({ total: 3, binary: 1, deleted: 1, renamed: 1 });
    expect(intelligence.changedFiles.paths.join(" ")).toMatch(/logo\.bin.*binary/);
    expect(intelligence.branch.pendingCommitCount).toBe(2);
    expect(intelligence.ciStatusHints[0]).toMatch(/Workflow files changed/i);
    expect(intelligence.blockers.accountState).toEqual(["Open PR count is high."]);
    expect(intelligence.blockers.branchQuality).toEqual([]);
    expect(JSON.stringify(intelligence)).not.toMatch(/export const|wallet|hotkey|farming|payout|trust score/i);
  });

  it("treats passed validation as test evidence when no test files changed", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "internal/entity/model.go", status: "modified" }],
        validation: [{ command: "go test ./internal/entity", status: "passed", summary: "focused regression passed" }],
      },
      analysis: {
        baseFreshness: {
          status: "stale",
          baseRef: "origin/main",
          warnings: ["Local branch is behind remote tracking SHA; run git fetch origin && git rebase origin/main."],
          changedFileCount: 1,
          testFileCount: 0,
          passedValidationCount: 1,
          recommendation: "Rebase onto the latest remote base before opening.",
        },
        branchQualityBlockers: ["Local branch base is stale."],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after rebasing onto the latest remote base.",
        prPacket: {
          titleSuggestion: "Entity model fix",
          markdown: "# Entity model fix\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: {
            passed: 1,
            failed: 0,
            notRun: 0,
            commands: [{ command: "go test ./internal/entity", status: "passed", summary: "focused regression passed" }],
          },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [{ path: "internal/entity/model.go", status: "modified" }],
    });

    expect(intelligence.testEvidence.level).toBe("validation_commands");
    expect(intelligence.baseFreshness.status).toBe("stale");
    expect(hasLocalTestEvidence({ tests: ["go test ./internal/entity"] })).toBe(true);
    expect(isTestPath("internal/entity/model_test.go")).toBe(true);
    expect(isTestPath("internal/entity/model.go")).toBe(false);

    const preflight = buildLocalDiffPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Entity model fix",
        changedFiles: ["internal/entity/model.go"],
        tests: ["go test ./internal/entity"],
        changedLineCount: 12,
      },
      repo,
      [],
      [],
    );
    expect(preflight.findings.map((finding) => finding.code)).not.toContain("local_diff_missing_tests");
  });

  it("treats a focused validation run as test evidence, matching the PR-packet summary", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "internal/entity/model.go", status: "modified" }],
        validation: [{ command: "vitest run internal/entity/model.test.ts", status: "focused", summary: "focused subset passed" }],
      },
      analysis: {
        baseFreshness: { status: "fresh", changedFileCount: 1, testFileCount: 0, passedValidationCount: 1, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Entity model fix",
          markdown: "# Entity model fix\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: {
            passed: 1,
            failed: 0,
            notRun: 0,
            commands: [{ command: "vitest run internal/entity/model.test.ts", status: "focused", summary: "focused subset passed" }],
          },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [{ path: "internal/entity/model.go", status: "modified" }],
    });

    expect(intelligence.testEvidence.passedValidationCount).toBe(1);
    expect(intelligence.testEvidence.level).toBe("validation_commands");
  });

  it("records metadata-only scorer diagnostics when no external scorer is configured", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        localScorer: { mode: "metadata_only", warnings: ["GITTENSOR_SCORE_PREVIEW_CMD is not configured."] },
      },
      analysis: {
        baseFreshness: { status: "unknown", changedFileCount: 0, testFileCount: 0, passedValidationCount: 0, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Local branch preflight",
          markdown: "# Local branch preflight\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [],
    });

    expect(intelligence.localScorerDiagnostics).toMatchObject({
      mode: "metadata_only",
      metadataOnly: true,
      warnings: expect.arrayContaining([expect.stringMatching(/not configured/i)]),
    });
    expect(intelligence.testEvidence.level).toBe("none");
  });

  it("bounds local scorer diagnostics before returning workspace intelligence", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        localScorer: {
          mode: "metadata_only",
          warnings: Array.from({ length: MAX_LOCAL_SCORER_WARNING_COUNT + 5 }, (_, index) => `${index}: ${"w".repeat(MAX_LOCAL_SCORER_WARNING_CHARS + 25)}`),
        },
      },
      analysis: {
        baseFreshness: { status: "unknown", changedFileCount: 0, testFileCount: 0, passedValidationCount: 0, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Local branch preflight",
          markdown: "# Local branch preflight\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [],
    });

    expect(intelligence.localScorerDiagnostics?.warnings).toHaveLength(MAX_LOCAL_SCORER_WARNING_COUNT);
    expect(intelligence.localScorerDiagnostics?.warnings.every((warning) => warning.length <= MAX_LOCAL_SCORER_WARNING_CHARS)).toBe(true);
  });

  it("records test_files evidence when only test paths changed", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        headSha: "abc123",
        localScorer: { mode: "external_command", activeModel: "fixture-model", warnings: [] },
        changedFiles: [{ path: "src/cache.test.ts", status: "added" }],
      },
      analysis: {
        baseFreshness: { status: "fresh", changedFileCount: 1, testFileCount: 1, passedValidationCount: 0, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Cache tests",
          markdown: "# Cache tests\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [{ path: "src/cache.test.ts", status: "added" }],
    });

    expect(intelligence.testEvidence.level).toBe("test_files");
    expect(intelligence.branch.headSha).toBe("abc123");
    expect(intelligence.localScorerDiagnostics).toMatchObject({ mode: "external_command", activeModel: "fixture-model", metadataOnly: false });
  });

  it("counts copied file changes as renames in summaries", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: { login: "oktofeesh1", repoFullName: repo.fullName },
      analysis: {
        baseFreshness: { status: "fresh", changedFileCount: 1, testFileCount: 0, passedValidationCount: 0, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Copy path",
          markdown: "# Copy path\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [{ path: "src/new.ts", previousPath: "src/old.ts", status: "copied" }],
    });

    expect(intelligence.changedFiles.renamed).toBe(1);
  });

  it("keeps linked issues sorted for stable public output", () => {
    const intelligence = buildLocalWorkspaceIntelligence({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        linkedIssues: [42, 7, 19],
      },
      analysis: {
        baseFreshness: { status: "fresh", changedFileCount: 0, testFileCount: 0, passedValidationCount: 0, warnings: [] },
        branchQualityBlockers: [],
        accountStateBlockers: [],
        recommendedRerunCondition: "Rerun after any branch, base, or PR state changes before opening/submitting.",
        prPacket: {
          titleSuggestion: "Local branch preflight",
          markdown: "# Local branch preflight\n",
          bodySections: [],
          reviewerNotes: [],
          validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] },
          publicSafeWarnings: [],
        },
      },
      changedFiles: [],
    });

    expect(intelligence.linkedIssues).toEqual([7, 19, 42]);
  });
});
