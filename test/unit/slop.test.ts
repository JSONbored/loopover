import { describe, expect, it } from "vitest";

import { buildCollisionReport } from "../../src/signals/engine";
import {
  buildSlopAssessment,
  findLowQualityCommitMessages,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";
import type { IssueRecord, PullRequestRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

function issue(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<IssueRecord> = {},
): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    labels: ["bug"],
    linkedPrs: [],
    ...overrides,
  };
}

function pr(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "contributor",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSlopAssessment", () => {
  it("raises the duplicate-cluster slop signal when the target PR belongs to a high-risk cluster", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 7, "Stabilize queue health signals", { linkedPrs: [41, 42] }),
    ];
    const pullRequests = [
      pr(repoFullName, 41, "Stabilize queue health signals", { linkedIssues: [7] }),
      pr(repoFullName, 42, "Alternative queue health stabilization", { linkedIssues: [7] }),
    ];

    const result = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 41,
    });

    expect(result.slopRisk).toBe(SLOP_WEIGHTS.duplicateClusterMembership);
    expect(result.band).toBe("elevated");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_cluster_membership",
          severity: "warning",
        }),
      ]),
    );
  });

  it("raises the commit-message slop signal for generic, empty, or template subjects", () => {
    const repoFullName = "JSONbored/gittensory";
    const result = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 8, "Track queue triage")],
      pullRequests: [pr(repoFullName, 51, "Track queue triage")],
      commitMessages: ["fix", "\n\n", "WIP"],
    });

    expect(result.slopRisk).toBe(60);
    expect(result.band).toBe("high");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "low_quality_commit_messages",
          severity: "warning",
        }),
      ]),
    );
  });

  it("aggregates both signals in one shared assessment", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 9, "Tighten duplicate cluster detection", { linkedPrs: [61, 62] }),
    ];
    const pullRequests = [
      pr(repoFullName, 61, "Tighten duplicate cluster detection", { linkedIssues: [9] }),
      pr(repoFullName, 62, "Duplicate cluster detector follow-up", { linkedIssues: [9] }),
    ];

    const result = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 61,
      commitMessages: ["update", "WIP"],
    });

    expect(result.slopRisk).toBe(75);
    expect(result.band).toBe("high");
    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      "duplicate_cluster_membership",
      "low_quality_commit_messages",
    ]);
  });

  it("does not raise either signal without a target PR and with descriptive commits", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [issue(repoFullName, 10, "Improve docs indexing")];
    const pullRequests = [
      pr(repoFullName, 71, "Add onboarding note", { linkedIssues: [10] }),
      pr(repoFullName, 72, "Unrelated queue report cleanup"),
    ];

    const result = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      commitMessages: [
        "feat(ci): annotate failing checks with branch-specific remediation",
        "docs(api): explain maintainer branch annotation payload",
      ],
    });

    expect(result).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("is deterministic for identical metadata input when prebuilt collisions are reused", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 11, "Resolve overlapping queue triage work", { linkedPrs: [81, 82] }),
    ];
    const pullRequests = [
      pr(repoFullName, 81, "Resolve overlapping queue triage work", { linkedIssues: [11] }),
      pr(repoFullName, 82, "Alternative overlapping queue triage work", { linkedIssues: [11] }),
    ];
    const collisions = buildCollisionReport(repoFullName, issues, pullRequests);

    const left = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 81,
      commitMessages: ["update", "WIP"],
      prebuiltCollisions: collisions,
    });
    const right = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 81,
      commitMessages: ["update", "WIP"],
      prebuiltCollisions: collisions,
    });

    expect(left).toEqual(right);
  });

  it("shares deterministic low-quality classification helpers for the future lint tool", () => {
    const messages = ["update", "feat(api): add branch annotation schema", "the and fix"];

    expect(findLowQualityCommitMessages(messages)).toEqual([
      expect.objectContaining({ subject: "update", reason: "generic_subject" }),
      expect.objectContaining({ subject: "the and fix", reason: "stopword_only_subject" }),
    ]);
    expect(findLowQualityCommitMessages(messages)).toEqual(findLowQualityCommitMessages(messages));
  });

  it("treats punctuation-only, two-bad-message, and long-template subjects consistently", () => {
    const repoFullName = "JSONbored/gittensory";
    expect(findLowQualityCommitMessages(["...", "minor fix"])).toEqual([
      expect.objectContaining({ subject: "...", reason: "empty_subject" }),
      expect.objectContaining({ subject: "minor fix", reason: "generic_subject" }),
    ]);

    const elevated = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 12, "Clarify CI notes")],
      pullRequests: [pr(repoFullName, 91, "Clarify CI notes")],
      commitMessages: ["update", "WIP"],
    });
    expect(elevated.slopRisk).toBe(40);
    expect(elevated.band).toBe("elevated");

    const longTemplate = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 13, "Trace branch changes")],
      pullRequests: [pr(repoFullName, 92, "Trace branch changes")],
      commitMessages: ["placeholder ".repeat(6).trim(), "temp", "fix"],
    });
    expect(longTemplate.findings[0]?.detail).toContain("...");
  });

  it("keeps the rubric and finding text public-safe", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 14, "Improve slop scoring", { linkedPrs: [101, 102] }),
    ];
    const pullRequests = [
      pr(repoFullName, 101, "Improve slop scoring", { linkedIssues: [14] }),
      pr(repoFullName, 102, "Alternative slop scoring change", { linkedIssues: [14] }),
    ];

    const result = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 101,
      commitMessages: ["temp"],
    });
    const publicText = [
      SLOP_RUBRIC_MARKDOWN,
      ...result.findings.flatMap((finding) => [
        finding.title,
        finding.detail,
        finding.action ?? "",
        finding.publicText ?? "",
      ]),
    ].join("\n");

    expect(publicText).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});
