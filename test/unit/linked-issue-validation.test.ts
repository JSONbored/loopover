import { describe, expect, it } from "vitest";
import { buildLinkedIssueValidation, type LinkedIssueValidationReport } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward|farming|raw trust|trust score|scoreability|reviewability/i;

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
    registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare: 1, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {}, ...overrides },
  };
}

function issue(number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "A clear issue body with reproduction steps and expected behaviour.",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function pr(number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return { repoFullName: "owner/repo", number, title, state: "open", authorLogin: "dev", authorAssociation: "NONE", labels: [], linkedIssues: [], body: "", updatedAt: new Date().toISOString(), ...overrides };
}

function mergedPr(number: number, title: string, overrides: Partial<RecentMergedPullRequestRecord> = {}): RecentMergedPullRequestRecord {
  return { repoFullName: "owner/repo", number, title, authorLogin: "solver", mergedAt: new Date().toISOString(), labels: [], linkedIssues: [], changedFiles: [], payload: {}, ...overrides };
}

function assertPublicSafe(report: LinkedIssueValidationReport): void {
  for (const line of [...report.reasons, ...report.warnings, report.summary, report.blockingReason ?? ""]) {
    expect(line).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  }
}

describe("buildLinkedIssueValidation", () => {
  it("reports the multiplier would apply for a clean, open, uncontested issue", () => {
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(1, "Fix crash on empty input")], [], [], "owner/repo", 1, { title: "Fix crash", changedFiles: ["src/parser.ts"] });
    expect(report.multiplierWouldApply).toBe(true);
    expect(report.multiplierStatus).toBe("validated");
    expect(report.found).toBe(true);
    expect(report.open).toBe(true);
    expect(report.blockingReason).toBeUndefined();
    expect(report.reasons.some((r) => /open, valid, and uncontested/i.test(r))).toBe(true);
    assertPublicSafe(report);
  });

  it("warns when no planned-change detail is supplied", () => {
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(1, "Fix crash on empty input")], [], [], "owner/repo", 1);
    expect(report.multiplierWouldApply).toBe(true);
    expect(report.warnings.some((w) => /No planned-change detail/i.test(w))).toBe(true);
    assertPublicSafe(report);
  });

  it("warns when the target issue is stale", () => {
    const stale = issue(1, "Fix crash on empty input", { updatedAt: "2024-01-01T00:00:00.000Z" });
    const report = buildLinkedIssueValidation(repo("owner/repo"), [stale], [], [], "owner/repo", 1, { title: "x", changedFiles: ["a.ts"] });
    expect(report.lifecycle).toBe("stale");
    expect(report.multiplierWouldApply).toBe(true);
    expect(report.warnings.some((w) => /stale/i.test(w))).toBe(true);
    assertPublicSafe(report);
  });

  it("does not apply when the issue is closed", () => {
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(1, "Already handled", { state: "closed" })], [], [], "owner/repo", 1);
    expect(report.open).toBe(false);
    expect(report.multiplierWouldApply).toBe(false);
    expect(report.blockingReason).toMatch(/is not open/i);
    assertPublicSafe(report);
  });

  it("does not apply for duplicate or invalid issues", () => {
    const dup = buildLinkedIssueValidation(repo("owner/repo"), [issue(1, "Dup", { labels: ["duplicate"] })], [], [], "owner/repo", 1);
    expect(dup.lifecycle).toBe("duplicate");
    expect(dup.multiplierWouldApply).toBe(false);
    expect(dup.multiplierStatus).toBe("invalid");

    const invalid = buildLinkedIssueValidation(repo("owner/repo"), [issue(2, "Nope", { labels: ["wontfix"] })], [], [], "owner/repo", 2);
    expect(invalid.lifecycle).toBe("invalid");
    expect(invalid.multiplierWouldApply).toBe(false);
    expect(invalid.multiplierStatus).toBe("invalid");
    assertPublicSafe(dup);
    assertPublicSafe(invalid);
  });

  it("does not apply when the issue is already solved by merged work", () => {
    const merged = [mergedPr(20, "Fix it", { linkedIssues: [3] })];
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(3, "Improve retry backoff")], [], merged, "owner/repo", 3);
    expect(report.lifecycle).toBe("valid_solved");
    expect(report.multiplierWouldApply).toBe(false);
    expect(report.blockingReason).toMatch(/already solved/i);
    assertPublicSafe(report);
  });

  it("does not apply when the issue is self-solved by the reporter's own merged PR", () => {
    const merged = [mergedPr(21, "Self fix", { linkedIssues: [5], authorLogin: "reporter" })];
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(5, "Tidy logging", { authorLogin: "reporter" })], [], merged, "owner/repo", 5);
    expect(report.lifecycle).toBe("solved");
    expect(report.multiplierWouldApply).toBe(false);
    expect(report.multiplierStatus).toBe("unavailable");
    expect(report.blockingReason).toMatch(/already solved/i);
    assertPublicSafe(report);
  });

  it("does not apply when another contributor's open PR contests the issue", () => {
    const prs = [
      pr(10, "WIP fix", { linkedIssues: [4], authorLogin: "someone-else" }),
      pr(11, "Abandoned attempt", { linkedIssues: [4], authorLogin: "third-party", state: "closed" }),
    ];
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(4, "Add pagination")], prs, [], "owner/repo", 4, { contributorLogin: "me" });
    expect(report.multiplierWouldApply).toBe(false);
    expect(report.blockingReason).toMatch(/another open PR already references/i);
    assertPublicSafe(report);
  });

  it("ignores the contributor's own open PR when checking for contention", () => {
    const prs = [pr(10, "My fix", { linkedIssues: [4], authorLogin: "me" })];
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(4, "Add pagination")], prs, [], "owner/repo", 4, { contributorLogin: "me", title: "fix", changedFiles: ["a.ts"] });
    expect(report.multiplierWouldApply).toBe(true);
    assertPublicSafe(report);
  });

  it("does not apply when the issue is not in cached metadata", () => {
    const report = buildLinkedIssueValidation(repo("owner/repo"), [issue(1, "Real issue")], [], [], "owner/repo", 999);
    expect(report.found).toBe(false);
    expect(report.multiplierWouldApply).toBe(false);
    expect(report.blockingReason).toMatch(/#999 was not found/i);
    assertPublicSafe(report);
  });
});
