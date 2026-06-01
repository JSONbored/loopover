import { describe, expect, it } from "vitest";
import {
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  isAuthorizedCommandActor,
  isMaintainerOnlyCommand,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
} from "../../src/github/commands";

describe("GitHub mention commands", () => {
  it("parses only explicit @gittensory commands", () => {
    expect(parseGittensoryMentionCommand(null)).toBeNull();
    expect(parseGittensoryMentionCommand("@gittensory")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("@gittensory preflight")?.name).toBe("preflight");
    expect(parseGittensoryMentionCommand("please @gittensory duplicate-check now")?.name).toBe("duplicate-check");
    expect(parseGittensoryMentionCommand("@gittensory reviewability")?.name).toBe("reviewability");
    expect(parseGittensoryMentionCommand("@gittensory repo-fit")?.name).toBe("repo-fit");
    expect(parseGittensoryMentionCommand("@gittensory packet")?.name).toBe("packet");
    expect(parseGittensoryMentionCommand("@gittensory queue-summary")?.name).toBe("queue-summary");
    expect(parseGittensoryMentionCommand("@gittensory confirmed-miners")?.name).toBe("confirmed-miners");
    expect(parseGittensoryMentionCommand("@gittensory review-now")?.name).toBe("review-now");
    expect(parseGittensoryMentionCommand("@gittensory needs-author")?.name).toBe("needs-author");
    expect(parseGittensoryMentionCommand("@gittensory duplicate-clusters")?.name).toBe("duplicate-clusters");
    expect(parseGittensoryMentionCommand("@gittensory unknown")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("gittensory preflight")).toBeNull();
    expect(isMaintainerOnlyCommand("queue-summary")).toBe(true);
    expect(isMaintainerOnlyCommand("preflight")).toBe(false);
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
        commandName: "queue-summary",
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "confirmed", snapshot: minerSnapshot() },
      }),
    ).toMatchObject({ authorized: false, reason: "maintainer_command_requires_maintainer" });
    expect(
      isAuthorizedCommandActor({
        commandName: "queue-summary",
        commenterLogin: "reviewer",
        commenterAssociation: "MEMBER",
      }),
    ).toMatchObject({ authorized: true, reason: "maintainer_invocation" });
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
    expect(body).toContain("**Findings**");
    expect(body).toContain("**Evidence**");
    expect(body).toContain("**Next actions**");
    expect(body).toContain("<summary>Source and freshness</summary>");
    expect(body).toContain("Source: cached Gittensory agent context.");
    expect(body).toContain("Freshness: agent run status completed.");
    expect(body).not.toContain("Decision snapshot is stale");
    expect(body).not.toContain("background rebuild");
    expect(body).not.toMatch(/wallet|hotkey|coldkey|estimated score|reward estimate|payout|farming|raw trust score|reviewability|private ranking|public score estimate|scoreability/i);
    expect(body).not.toMatch(/private context,\s*private context/i);
    expect(sanitizePublicComment("wallet hotkey payout reviewability private ranking")).not.toMatch(
      /wallet|hotkey|payout|reviewability|private ranking/i,
    );
    expect(sanitizePublicComment("public score estimate and scoreability should stay private")).not.toMatch(/public score estimate|scoreability/i);
    expect(sanitizePublicComment("public score estimate private scoreability context score preview")).not.toMatch(/public score estimate|scoreability|score preview/i);
    expect(sanitizePublicComment("Command: @gittensory reviewability")).toContain("@gittensory reviewability");
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
    expect(help).toContain("<summary>Source and freshness</summary>");
    expect(help).toContain("Source: static command catalog.");
    expect(help).toContain("Freshness: shipped command list.");
    expect(help).toContain("<summary>Additional safe details</summary>");
    expect(help).toContain("@gittensory next-action");

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
    expect(refresh).toContain("Freshness: snapshot refresh in progress.");
    expect(refresh).toContain("Retry after the contributor decision snapshot refresh completes.");

    const preflightRefresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 31, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-preflight-refresh",
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
    expect(preflightRefresh).toContain("**Preflight snapshot refresh**");

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

    const noBundleNextAction = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 48, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
    });
    expect(noBundleNextAction).toContain("**Recommended next step**");
    expect(noBundleNextAction).toContain("No public-safe context is available");

    const emptyBlockers = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 45, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-empty-blockers"),
        actions: [],
        contextSnapshots: [],
        summary: "empty blockers",
      },
    });
    expect(emptyBlockers).toContain("No public readiness blockers are visible");

    const emptyDuplicate = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 46, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-empty-duplicate"),
        actions: [],
        contextSnapshots: [],
        summary: "empty duplicate",
      },
    });
    expect(emptyDuplicate).toContain("No duplicate or work-in-progress collision signal is visible");

    const missingDigest = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory queue-summary")!,
      repo: null,
      issue: { number: 47, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
    });
    expect(missingDigest).toContain("Cached queue context is unavailable");

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

    const blockersWithDuplicateCodes = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 24, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-blockers-duplicate-codes"),
        actions: [
          {
            id: "blocker-duplicate-codes",
            runId: "run-blockers-duplicate-codes",
            actionType: "explain_score_blockers",
            status: "blocked",
            recommendation: "Wait for review capacity",
            why: [],
            blockedBy: ["open_pr_pressure", "open_pr_pressure"],
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
    expect(blockersWithDuplicateCodes.match(/Open pull request queue pressure/g)).toHaveLength(1);

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

    const duplicateBlockerLabels = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 25, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-dedupe-blockers"),
        actions: [
          {
            id: "dedupe-blockers",
            runId: "run-dedupe-blockers",
            actionType: "explain_score_blockers",
            status: "blocked",
            recommendation: "Resolve blockers",
            why: [],
            blockedBy: ["open_pr_pressure", "open_pr_pressure"],
            publicSafeSummary: "Resolve queue pressure.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "dedupe",
      },
    });
    expect(duplicateBlockerLabels.match(/Open pull request queue pressure/g)).toHaveLength(1);

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

  it("renders v2 reviewability, repo-fit, and packet sections without private internals", () => {
    const reviewability = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory reviewability")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 31, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: preflightBundle(),
    });
    expect(reviewability).toContain("### Gittensory PR readiness");
    expect(reviewability).toContain("Command: `@gittensory reviewability`");
    expect(reviewability).toContain("**PR readiness**");
    expect(reviewability).toContain("Run local branch preflight first.");
    expect(reviewability).not.toMatch(/private reviewability|reviewability internals|scoreability|public score estimate|wallet|hotkey|payout|farming/i);

    const repoFit = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory repo-fit")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 32, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: repoFitBundle(),
    });
    expect(repoFit).toContain("### Gittensory repository fit");
    expect(repoFit).toContain("**Repository fit**");
    expect(repoFit).toContain("Target: `owner/repo`");
    expect(repoFit).toContain("Use local branch preflight before posting.");
    expect(repoFit).not.toMatch(/private reviewability|scoreability|public score estimate|wallet|hotkey|payout|farming/i);

    const packet = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory packet")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 33, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: packetBundle(),
    });
    expect(packet).toContain("### Gittensory public packet");
    expect(packet).toContain("**Public packet**");
    expect(packet).toContain("public-safe PR packet prepared from metadata only.");
    expect(packet).toContain("Use this as public PR-thread guidance only");
    expect(packet).not.toMatch(/private reviewability|scoreability|public score estimate|wallet|hotkey|payout|farming/i);
  });

  it("covers v2 refresh, empty, rerun, and duplicate-line fallbacks", () => {
    const preflightRefresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 40, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: refreshBundle(),
    });
    expect(preflightRefresh).toContain("**Preflight snapshot refresh**");

    for (const [commandText, title, fallback] of [
      ["@gittensory blockers", "Readiness blockers", "No public readiness blockers are visible"],
      ["@gittensory duplicate-check", "Duplicate & WIP caution", "No duplicate or work-in-progress collision signal is visible"],
    ] as const) {
      const body = buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(commandText)!,
        repo: null,
        issue: { number: 40, title: "PR", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "author",
        bundle: emptyBundle(),
      });
      expect(body).toContain(`**${title}**`);
      expect(body).toContain(fallback);
    }

    for (const [commandText, title] of [
      ["@gittensory reviewability", "PR readiness snapshot refresh"],
      ["@gittensory repo-fit", "Repository fit snapshot refresh"],
      ["@gittensory packet", "Public packet snapshot refresh"],
    ] as const) {
      const body = buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(commandText)!,
        repo: null,
        issue: { number: 41, title: "PR", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "author",
        bundle: refreshBundle(),
      });
      expect(body).toContain(`**${title}**`);
    }

    for (const [commandText, title] of [
      ["@gittensory reviewability", "PR readiness"],
      ["@gittensory repo-fit", "Repository fit"],
      ["@gittensory packet", "Public packet"],
    ] as const) {
      const body = buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(commandText)!,
        repo: null,
        issue: { number: 42, title: "PR", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "author",
        bundle: emptyBundle(),
      });
      expect(body).toContain(`**${title}**`);
      expect(body).toContain("No public-safe context is available");
    }

    const repoFitWithRerun = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory repo-fit")!,
      repo: null,
      issue: { number: 43, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-repo-fit-rerun"),
        actions: [
          {
            id: "repo-fit-rerun",
            runId: "run-repo-fit-rerun",
            actionType: "choose_next_work" as const,
            status: "recommended" as const,
            recommendation: "Choose next work",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Repository fit is acceptable after public checks.",
            rerunWhen: "After queue changes.",
            approvalRequired: true,
            safetyClass: "private" as const,
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "repo fit",
      },
    });
    expect(repoFitWithRerun).toContain("Rerun when: After queue changes.");
    expect(repoFitWithRerun).not.toContain("Target:");

    const repoFitFromSummary = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory repo-fit")!,
      repo: null,
      issue: { number: 43, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-repo-fit-summary"),
        actions: [
          {
            id: "repo-fit-summary",
            runId: "run-repo-fit-summary",
            actionType: "monitor_existing_pr" as const,
            status: "recommended" as const,
            recommendation: "Explain repository fit",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Repository fit looks clean from cached public evidence.",
            approvalRequired: true,
            safetyClass: "private" as const,
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "repo fit",
      },
    });
    expect(repoFitFromSummary).toContain("Repository fit looks clean");

    const packetFromSafetyClass = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory packet")!,
      repo: null,
      issue: { number: 43, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-packet-safety-class"),
        actions: [
          {
            id: "packet-safety-class",
            runId: "run-packet-safety-class",
            actionType: "monitor_existing_pr" as const,
            status: "recommended" as const,
            recommendation: "Use packet",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Post the public-safe PR packet after validation.",
            approvalRequired: false,
            safetyClass: "public_safe" as const,
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "packet",
      },
    });
    expect(packetFromSafetyClass).toContain("Post the public-safe PR packet");

    const duplicateBlockers = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 44, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-duplicate-blockers"),
        actions: [
          {
            id: "duplicate-blockers",
            runId: "run-duplicate-blockers",
            actionType: "explain_score_blockers" as const,
            status: "blocked" as const,
            recommendation: "Resolve blockers",
            why: [],
            blockedBy: ["open_pr_pressure", "open_pr_pressure"],
            publicSafeSummary: "Resolve queue pressure before opening more work.",
            approvalRequired: true,
            safetyClass: "private" as const,
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "blockers",
      },
    });
    expect(duplicateBlockers.match(/Open pull request queue pressure/g)).toHaveLength(1);
  });

  it("builds maintainer-only queue digests with safe routing, sorting, and private-detail pointers", () => {
    const digest = sampleMaintainerDigest();
    expect(digest.totals.confirmedMinerPullRequests).toBe(2);
    expect(digest.reviewNowPullRequests.map((pr) => pr.number)).toEqual([10, 11]);
    expect(digest.needsAuthorPullRequests[0]?.signals).toContain("duplicate_or_overlap");
    expect(digest.needsAuthorPullRequests.map((pr) => pr.number)).toEqual(expect.arrayContaining([12, 13, 14, 15]));
    expect(digest.duplicateClusters.length).toBeGreaterThan(0);

    const reversedDigest = sampleMaintainerDigest({ reversePullRequests: true });
    expect(reversedDigest.reviewNowPullRequests.map((pr) => pr.number)).toEqual(digest.reviewNowPullRequests.map((pr) => pr.number));
    expect(reversedDigest.needsAuthorPullRequests.map((pr) => pr.number)).toEqual(digest.needsAuthorPullRequests.map((pr) => pr.number));

    const queueSummary = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory queue-summary")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    expect(queueSummary).toContain("### Gittensory maintainer queue summary");
    expect(queueSummary).toContain("**Queue summary**");
    expect(queueSummary).toContain("Authenticated control panel: https://gittensory.test/app?view=maintainer&repo=owner%2Frepo");
    expect(queueSummary).toContain("Feedback on this response is tracked separately");
    expect(queueSummary).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);

    const confirmed = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory confirmed-miners")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    expect(confirmed).toContain("**Confirmed-miner PRs**");
    expect(confirmed).toContain("#10: Ready linked fix");
    expect(confirmed).toContain("#13: Cache overlap first");

    const reviewNow = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory review-now")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    expect(reviewNow).toContain("**Review-now candidates**");
    expect(reviewNow).toContain("#10: Ready linked fix");
    expect(reviewNow).not.toContain("#12: Needs issue context");

    const needsAuthor = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory needs-author")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    expect(needsAuthor).toContain("**Needs-author queue**");
    expect(needsAuthor).toContain("Missing linked issue or no-issue rationale.");
    expect(needsAuthor).toContain("1 cached check(s) need attention.");
    expect(needsAuthor).toContain("Possible duplicate or WIP overlap");

    const duplicateClusters = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-clusters")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    expect(duplicateClusters).toContain("**Duplicate/WIP clusters**");
    expect(duplicateClusters).toContain("risk:");

    const defensiveDigest = buildMaintainerQueueDigest({
      repo: null,
      issues: [issue(5, "Medium overlap issue")],
      pullRequests: [
        { ...pr(16, "Long medium overlap implementation title that should be shortened in public queue output because it exceeds the digest line budget", "gina", { linkedIssues: [5], updatedAt: "not-a-date" }) },
        { repoFullName: "owner/repo", number: 17, title: "No timestamp review candidate", state: "open", authorLogin: "hal", authorAssociation: "NONE", labels: [], linkedIssues: [6], body: "Fixes #6" },
        { repoFullName: "owner/repo", number: 18, title: "Maintainer draft stewardship", state: "open", authorLogin: "ivy", authorAssociation: "OWNER", isDraft: true, labels: [], linkedIssues: [7], body: "Fixes #7" },
      ],
      recentMergedPullRequests: [
        {
          repoFullName: "owner/repo",
          number: 200,
          title: "Long medium overlap implementation title that should be shortened in public queue output because it exceeds the digest line budget",
          labels: [],
          linkedIssues: [5],
          changedFiles: [],
          payload: {},
        },
      ],
    });
    const defensiveClusters = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-clusters")!,
      repo: null,
      issue: { number: 100, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: defensiveDigest,
    });
    expect(defensiveClusters).toContain("medium risk:");
    expect(defensiveClusters).toContain("...");
    const defensiveSummary = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory queue-summary")!,
      repo: null,
      issue: { number: 101, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: defensiveDigest,
    });
    expect(defensiveSummary).toContain("Use the authenticated maintainer dashboard and private API");
    expect(defensiveDigest.needsAuthorPullRequests.find((pr) => pr.number === 18)?.reasons).toContain("Maintainer-authored PR; review as repo stewardship.");
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

function preflightBundle() {
  return {
    run: completedRun("run-preflight-v2"),
    actions: [
      {
        id: "preflight",
        runId: "run-preflight-v2",
        actionType: "preflight_branch" as const,
        status: "ready" as const,
        recommendation: "Preflight passed",
        why: [],
        blockedBy: [],
        publicSafeSummary: "Run local branch preflight first.",
        rerunWhen: "After CI completes.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "preflight",
  };
}

function repoFitBundle() {
  return {
    run: completedRun("run-repo-fit-v2"),
    actions: [
      {
        id: "repo-fit",
        runId: "run-repo-fit-v2",
        actionType: "explain_repo_fit" as const,
        targetRepoFullName: "owner/repo",
        status: "recommended" as const,
        recommendation: "Use repo fit context",
        why: [],
        blockedBy: [],
        publicSafeSummary: "Use local branch preflight before posting.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "repo fit",
  };
}

function packetBundle() {
  return {
    run: completedRun("run-packet-v2"),
    actions: [
      {
        id: "packet",
        runId: "run-packet-v2",
        actionType: "prepare_pr_packet" as const,
        status: "ready" as const,
        recommendation: "Prepare packet",
        why: [],
        blockedBy: [],
        publicSafeSummary: "owner/repo: public-safe PR packet prepared from metadata only.",
        rerunWhen: "After validation changes.",
        approvalRequired: false,
        safetyClass: "public_safe" as const,
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "packet",
  };
}

function refreshBundle() {
  return {
    run: {
      ...completedRun("run-refresh-v2"),
      status: "needs_snapshot_refresh" as const,
      dataQualityStatus: "unknown" as const,
    },
    actions: [],
    contextSnapshots: [],
    summary: "refresh",
  };
}

function emptyBundle() {
  return {
    run: completedRun("run-empty-v2"),
    actions: [],
    contextSnapshots: [],
    summary: "empty",
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

function sampleMaintainerDigest(options: { reversePullRequests?: boolean } = {}) {
  const pullRequests = [
    pr(10, "Ready linked fix", "alice", { linkedIssues: [1], updatedAt: "2099-01-01T00:00:00.000Z" }),
    pr(11, "Documentation reference update", "bob", { linkedIssues: [2], updatedAt: "2099-01-01T00:00:00.000Z" }),
    pr(12, "Needs issue context", "carol", { linkedIssues: [], updatedAt: "2099-01-01T00:00:00.000Z" }),
    pr(13, "Cache overlap first", "dave", { linkedIssues: [3], updatedAt: "2099-01-01T00:00:00.000Z" }),
    pr(14, "Cache overlap second", "erin", { linkedIssues: [3], updatedAt: "2099-01-01T00:00:00.000Z" }),
    pr(15, "Legacy cleanup request", "frank", { linkedIssues: [4], updatedAt: "2020-01-01T00:00:00.000Z" }),
  ];
  return buildMaintainerQueueDigest({
    repo: { fullName: "owner/repo", isRegistered: true, registryConfig: { emissionShare: 0.1, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {}, repo: "owner/repo" } } as any,
    issues: [
      issue(1, "Ready linked fix"),
      issue(2, "Documentation reference update"),
      issue(3, "Cache overlap issue"),
      issue(4, "Legacy cleanup request"),
    ],
    pullRequests: options.reversePullRequests ? [...pullRequests].reverse() : pullRequests,
    confirmedMinerLogins: ["alice", "dave"],
    checkSummariesByPullNumber: {
      12: [{ id: "check-12", repoFullName: "owner/repo", pullNumber: 12, name: "validate", status: "completed", conclusion: "failure", payload: {} }],
    },
    controlPanelUrl: "https://gittensory.test/app?view=maintainer&repo=owner%2Frepo",
  });
}

function pr(number: number, title: string, authorLogin: string, options: { linkedIssues: number[]; updatedAt: string }) {
  return {
    repoFullName: "owner/repo",
    number,
    title,
    state: "open",
    authorLogin,
    authorAssociation: "NONE",
    updatedAt: options.updatedAt,
    createdAt: options.updatedAt,
    labels: [],
    linkedIssues: options.linkedIssues,
    body: options.linkedIssues.map((issueNumber) => `Fixes #${issueNumber}`).join("\n"),
  };
}

function issue(number: number, title: string) {
  return {
    repoFullName: "owner/repo",
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    labels: [],
    linkedPrs: [],
  };
}
