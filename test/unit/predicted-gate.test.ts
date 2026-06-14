import { describe, expect, it } from "vitest";
import { buildPredictedGateVerdict, type PredictedGateInput } from "../../src/rules/predicted-gate";
import { parseFocusManifest } from "../../src/signals/focus-manifest";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const REPO: RepositoryRecord = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };

function openPr(number: number, title: string, linkedIssues: number[] = [], authorLogin = "someone"): PullRequestRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", authorLogin, linkedIssues, labels: [] };
}

function openIssue(number: number, title: string): IssueRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", labels: [], linkedPrs: [], authorAssociation: null } as IssueRecord;
}

const BASE_INPUT: PredictedGateInput = {
  repoFullName: "acme/widgets",
  contributorLogin: "miner1",
  title: "Add retry to the upload client",
  body: "Closes #7",
  linkedIssues: [7],
};

function verdict(args: { gate: Record<string, unknown>; input?: Partial<PredictedGateInput>; issues?: IssueRecord[]; pullRequests?: PullRequestRecord[] }) {
  return buildPredictedGateVerdict({
    input: { ...BASE_INPUT, ...args.input },
    manifest: parseFocusManifest({ gate: args.gate }),
    repo: REPO,
    issues: args.issues ?? [openIssue(7, "Uploads should retry on 5xx")],
    pullRequests: args.pullRequests ?? [],
  });
}

describe("buildPredictedGateVerdict", () => {
  it("predicts a pass for a clean diff with a linked issue and no duplicate", () => {
    const result = verdict({ gate: { duplicates: "block", linkedIssue: "advisory" } });
    expect(result.predicted).toBe(true);
    expect(result.basis).toBe("public_config");
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toHaveLength(0);
    expect(result.note).toContain("public .gittensory.yml");
  });

  it("predicts a BLOCK when a duplicate PR exists and duplicates:block (the default)", () => {
    // Another open PR already targets the same linked issue → duplicate_pr_risk.
    const result = verdict({ gate: { duplicates: "block" }, pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
    // Public-safe: blocker text carries a fix and no raw internal markers.
    expect(result.title.toLowerCase()).toContain("gittensory gate");
  });

  it("does NOT block on a duplicate when duplicates:off", () => {
    const result = verdict({ gate: { duplicates: "off" }, pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
    expect(result.conclusion).not.toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(false);
  });

  it("predicts a BLOCK for a missing linked issue only when linkedIssue:block", () => {
    const blocked = verdict({ gate: { linkedIssue: "block" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);

    // Default (advisory) → not a hard blocker.
    const advisory = verdict({ gate: { linkedIssue: "advisory" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(advisory.blockers.some((b) => b.code === "missing_linked_issue")).toBe(false);
  });

  it("forces a neutral prediction for a self-declared non-confirmed contributor", () => {
    const result = buildPredictedGateVerdict({
      input: { ...BASE_INPUT, body: "no issue", linkedIssues: [] },
      manifest: parseFocusManifest({ gate: { linkedIssue: "block" } }),
      repo: REPO,
      issues: [],
      pullRequests: [],
      confirmedContributor: false, // a non-confirmed contributor is never hard-blocked by the real gate
    });
    expect(result.conclusion).toBe("neutral");
    expect(result.blockers).toHaveLength(0);
  });
});
