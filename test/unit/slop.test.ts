import { describe, expect, it } from "vitest";

import { buildCollisionReport } from "../../src/signals/engine";
import {
  buildSlopAssessment,
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
  it("raises the slop signal when the target PR belongs to a high-risk duplicate cluster", () => {
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

  it("does not raise the signal without a target PR or when the target PR is unrelated", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [issue(repoFullName, 8, "Improve docs indexing")];
    const pullRequests = [
      pr(repoFullName, 51, "Add onboarding note", { linkedIssues: [8] }),
      pr(repoFullName, 52, "Unrelated queue report cleanup"),
    ];

    const noTarget = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
    });
    const unrelated = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 52,
    });

    expect(noTarget).toEqual({ slopRisk: 0, band: "clean", findings: [] });
    expect(unrelated).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("is deterministic for identical metadata input", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 9, "Tighten duplicate cluster detection", { linkedPrs: [61, 62] }),
    ];
    const pullRequests = [
      pr(repoFullName, 61, "Tighten duplicate cluster detection", { linkedIssues: [9] }),
      pr(repoFullName, 62, "Duplicate cluster detector follow-up", { linkedIssues: [9] }),
    ];
    const collisions = buildCollisionReport(repoFullName, issues, pullRequests);

    const left = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 61,
      prebuiltCollisions: collisions,
    });
    const right = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 61,
      prebuiltCollisions: collisions,
    });

    expect(left).toEqual(right);
  });

  it("keeps the rubric and finding text public-safe", () => {
    const repoFullName = "JSONbored/gittensory";
    const issues = [
      issue(repoFullName, 10, "Resolve overlapping queue triage work", { linkedPrs: [71, 72] }),
    ];
    const pullRequests = [
      pr(repoFullName, 71, "Resolve overlapping queue triage work", { linkedIssues: [10] }),
      pr(repoFullName, 72, "Alternative overlapping queue triage work", { linkedIssues: [10] }),
    ];

    const result = buildSlopAssessment({
      repoFullName,
      issues,
      pullRequests,
      targetPullRequestNumber: 71,
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
