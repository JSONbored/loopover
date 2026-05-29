import { describe, expect, it } from "vitest";
import {
  buildPublicAgentCommandComment,
  isAuthorizedCommandActor,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
} from "../../src/github/commands";

describe("GitHub mention commands", () => {
  it("parses only explicit @gittensory commands", () => {
    expect(parseGittensoryMentionCommand(null)).toBeNull();
    expect(parseGittensoryMentionCommand("@gittensory")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("@gittensory preflight")?.name).toBe("preflight");
    expect(parseGittensoryMentionCommand("please @gittensory duplicate-check now")?.name).toBe("duplicate-check");
    expect(parseGittensoryMentionCommand("@gittensory unknown")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("gittensory preflight")).toBeNull();
  });

  it("authorizes maintainers and confirmed miner PR authors only", () => {
    expect(isAuthorizedCommandActor({ commenterLogin: "reviewer", commenterAssociation: "OWNER" })).toMatchObject({
      authorized: true,
      actorKind: "maintainer",
    });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "confirmed", snapshot: minerSnapshot() },
      }),
    ).toMatchObject({ authorized: true, reason: "confirmed_miner_pr_author" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "unavailable", error: "api down" },
      }),
    ).toMatchObject({ authorized: false, reason: "miner_detection_unavailable" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "not_found" },
      }),
    ).toMatchObject({ authorized: false, reason: "pr_author_not_confirmed_miner" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "other",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "confirmed", snapshot: minerSnapshot() },
      }),
    ).toMatchObject({ authorized: false, reason: "not_maintainer_or_pr_author" });
  });

  it("keeps public comments sanitized", () => {
    const command = parseGittensoryMentionCommand("@gittensory next-action")!;
    const body = buildPublicAgentCommandComment({
      command,
      repo: null,
      issue: { number: 12, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: minerSnapshot(),
      bundle: {
        run: {
          id: "run-1",
          objective: "plan",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: { freshness: "rebuilding", rebuildEnqueued: true },
        },
        actions: [
          {
            id: "action-1",
            runId: "run-1",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "private recommendation",
            why: [],
            blockedBy: ["estimated score and wallet should be hidden"],
            publicSafeSummary: "Use a narrow PR packet; reward estimate should not leak.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "done",
      },
    });
    expect(body).toContain("<!-- gittensory-agent-command -->");
    expect(body).toContain("Scope: this repository#12");
    expect(body).not.toContain("Decision snapshot is stale");
    expect(body).not.toContain("background rebuild");
    expect(body).not.toMatch(/wallet|hotkey|coldkey|estimated score|reward estimate|payout|farming|raw trust score|reviewability|private ranking/i);
    expect(body).not.toMatch(/private context,\s*private context/i);
    expect(sanitizePublicComment("wallet hotkey payout reviewability private ranking")).not.toMatch(
      /wallet|hotkey|payout|reviewability|private ranking/i,
    );
    expect(sanitizePublicComment("private ranking, wallet, payout")).toBe("private context");
  });

  it("renders command-specific sections for preflight, blockers, duplicate-check, and next-action", () => {
    const bundle = sampleBundle();

    const preflight = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 10, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle,
    });
    expect(preflight).toContain("### Gittensory preflight");
    expect(preflight).toContain("**Preflight summary**");
    expect(preflight).toContain("Run local branch preflight first.");

    const blockers = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 11, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: blockerBundle(),
    });
    expect(blockers).toContain("### Gittensory readiness blockers");
    expect(blockers).toContain("**Readiness blockers**");
    expect(blockers).toContain("Resolve queue pressure before opening more work.");
    expect(blockers).toContain("Open pull request queue pressure");
    expect(blockers).not.toContain("5 open PR(s)");

    const duplicateCheck = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 12, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: duplicateBundle(),
    });
    expect(duplicateCheck).toContain("### Gittensory duplicate & WIP check");
    expect(duplicateCheck).toContain("**Duplicate & WIP caution**");
    expect(duplicateCheck).toContain("possible overlap with existing work");
    expect(duplicateCheck).not.toMatch(/\blikely_duplicate\b/i);

    const nextAction = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 13, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle,
    });
    expect(nextAction).toContain("### Gittensory next step");
    expect(nextAction).toContain("**Recommended next step**");
    expect(nextAction).toContain("After tests pass.");
  });

  it("does not publish private blocker why details", () => {
    const body = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 24, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-private-blockers"),
        actions: [
          {
            id: "private-blockers",
            runId: "run-private-blockers",
            actionType: "explain_score_blockers",
            status: "blocked",
            recommendation: "Resolve blockers",
            why: [
              "5 open PR(s) create scoreability and review-pressure risk.",
              "Closed PR rate is 48%.",
              "Official repo credibility is 0.42.",
            ],
            blockedBy: ["open_pr_pressure", "closed_pr_credibility", "low_credibility"],
            publicSafeSummary: "Resolve public readiness blockers before opening more work.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "blockers",
      },
    });

    expect(body).toContain("Resolve public readiness blockers before opening more work.");
    expect(body).toContain("Open pull request queue pressure");
    expect(body).toContain("Closed pull request credibility signal");
    expect(body).toContain("Contributor credibility needs improvement");
    expect(body).not.toMatch(/5 open PR\(s\)|Closed PR rate is 48%|Official repo credibility is 0\.42/i);
  });

  it("renders help, miner-context fallback, refresh, and empty-action responses", () => {
    const help = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory help")!,
      repo: null,
      issue: { number: 1, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
    });
    expect(help).toContain("@gittensory duplicate-check");

    const minerFallback = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory miner-context")!,
      repo: null,
      issue: { number: 2, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: null,
    });
    expect(minerFallback).toContain("Official miner context is unavailable");

    const minerContext = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory miner-context")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 22, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: minerSnapshot(),
    });
    expect(minerContext).toContain("confirmed by the official Gittensor API");
    expect(minerContext).toContain("Scope: owner/repo#22");

    const refresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 3, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-refresh",
          objective: "refresh",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "needs_snapshot_refresh",
          dataQualityStatus: "unknown",
          payload: {},
        },
        actions: [],
        contextSnapshots: [],
        summary: "refresh",
      },
    });
    expect(refresh).toContain("**Blocker snapshot refresh**");

    const duplicateRefresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 33, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-duplicate-refresh",
          objective: "refresh",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "needs_snapshot_refresh",
          dataQualityStatus: "unknown",
          payload: {},
        },
        actions: [],
        contextSnapshots: [],
        summary: "refresh",
      },
    });
    expect(duplicateRefresh).toContain("**Duplicate-check snapshot refresh**");

    const empty = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 4, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-empty",
          objective: "empty",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: {},
        },
        actions: [],
        contextSnapshots: [],
        summary: "empty",
      },
    });
    expect(empty).toContain("**Recommended next step**");
    expect(empty).toContain("No public-safe context is available");

    const noBundle = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 44, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
    });
    expect(noBundle).toContain("**Preflight summary**");
    expect(noBundle).toContain("No public-safe context is available");

    const withPrFallbackScope = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 5, title: "PR", state: "open", pull_request: {} },
      pullRequest: { repoFullName: "owner/from-pr" } as any,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-action",
          objective: "action",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: {},
        },
        actions: [
          {
            id: "action",
            runId: "run-action",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "recommendation",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Run local branch preflight first.",
            rerunWhen: "After tests pass.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "done",
      },
    });
    expect(withPrFallbackScope).toContain("Scope: owner/from-pr#5");
    expect(withPrFallbackScope).toContain("After tests pass.");
  });

  it("covers blocker label fallbacks, rerun bullets, and duplicate-risk heuristics", () => {
    const blockersWithFallbackLabel = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 20, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-blockers-fallback"),
        actions: [
          {
            id: "blocker-fallback",
            runId: "run-blockers-fallback",
            actionType: "monitor_existing_pr",
            status: "blocked",
            recommendation: "Wait for review capacity",
            why: [],
            blockedBy: ["custom_signal_code"],
            publicSafeSummary: "Reduce concurrent review load.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "blockers",
      },
    });
    expect(blockersWithFallbackLabel).toContain("custom signal code");
    expect(blockersWithFallbackLabel).toContain("Reduce concurrent review load.");

    const duplicateViaRecommendation = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 21, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-duplicate-rec"),
        actions: [
          {
            id: "duplicate-rec",
            runId: "run-duplicate-rec",
            actionType: "monitor_existing_pr",
            status: "watch",
            recommendation: "Compare WIP overlap with active pull requests",
            why: ["Maintainer queue is busy"],
            blockedBy: [],
            riskImpact: "Concurrent review pressure",
            publicSafeSummary: "Review linked issues before requesting detailed review.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "duplicate",
      },
    });
    expect(duplicateViaRecommendation).toContain("**Duplicate & WIP caution**");
    expect(duplicateViaRecommendation).toMatch(/overlap|WIP|Concurrent/i);

    const preflightWithRerun = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 22, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-preflight-rerun"),
        actions: [
          {
            id: "preflight-rerun",
            runId: "run-preflight-rerun",
            actionType: "prepare_pr_packet",
            status: "recommended",
            recommendation: "Prepare packet",
            why: [],
            blockedBy: ["open_pr_pressure"],
            publicSafeSummary: "Run local branch preflight first.",
            rerunWhen: "After CI completes.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "preflight",
      },
    });
    expect(preflightWithRerun).toContain("Rerun when:");
    expect(preflightWithRerun).toContain("Open pull request queue pressure");

    const duplicateFallbackPick = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 23, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-duplicate-fallback"),
        actions: [
          {
            id: "fallback-action",
            runId: "run-duplicate-fallback",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "Pick the next issue",
            why: [],
            blockedBy: [],
            publicSafeSummary: "No duplicate signal in this fallback action.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "fallback",
      },
    });
    expect(duplicateFallbackPick).toContain("No duplicate signal in this fallback action.");
  });
});

function completedRun(id: string) {
  return {
    id,
    objective: "test",
    actorLogin: "oktofeesh1",
    surface: "github_comment" as const,
    mode: "copilot" as const,
    status: "completed" as const,
    dataQualityStatus: "complete" as const,
    payload: {},
  };
}

function sampleBundle() {
  return {
    run: {
      id: "run-action",
      objective: "action",
      actorLogin: "oktofeesh1",
      surface: "github_comment" as const,
      mode: "copilot" as const,
      status: "completed" as const,
      dataQualityStatus: "complete" as const,
      payload: {},
    },
    actions: [
      {
        id: "action",
        runId: "run-action",
        actionType: "choose_next_work" as const,
        status: "recommended" as const,
        recommendation: "recommendation",
        why: [],
        blockedBy: [],
        publicSafeSummary: "Run local branch preflight first.",
        rerunWhen: "After tests pass.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "done",
  };
}

function blockerBundle() {
  return {
    run: {
      id: "run-blockers",
      objective: "blockers",
      actorLogin: "maintainer",
      surface: "github_comment" as const,
      mode: "copilot" as const,
      status: "completed" as const,
      dataQualityStatus: "complete" as const,
      payload: {},
    },
    actions: [
      {
        id: "blocker-action",
        runId: "run-blockers",
        actionType: "explain_score_blockers" as const,
        status: "blocked" as const,
        recommendation: "Resolve blockers",
        why: ["open_pr_pressure: 5 open PR(s) create review-pressure risk."],
        blockedBy: ["open_pr_pressure"],
        publicSafeSummary: "Resolve queue pressure before opening more work.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "blockers",
  };
}

function duplicateBundle() {
  return {
    run: {
      id: "run-duplicate",
      objective: "duplicate-check",
      actorLogin: "maintainer",
      surface: "github_comment" as const,
      mode: "copilot" as const,
      status: "completed" as const,
      dataQualityStatus: "complete" as const,
      payload: {},
    },
    actions: [
      {
        id: "duplicate-action",
        runId: "run-duplicate",
        actionType: "check_duplicate_risk" as const,
        status: "watch" as const,
        recommendation: "Compare overlap",
        why: ["likely_duplicate cluster detected against an active PR."],
        blockedBy: ["likely_duplicate"],
        riskImpact: "High-risk duplicate/WIP collision cluster.",
        publicSafeSummary: "Compare against linked issues and active PRs before detailed review.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "duplicate",
  };
}

function minerSnapshot() {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: "oktofeesh1",
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: {
      pullRequests: 3,
      mergedPullRequests: 2,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}
