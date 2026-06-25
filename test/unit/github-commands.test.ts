import { describe, expect, it } from "vitest";
import {
  buildAgentCommandFeedbackMarker,
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  isAuthorizedCommandActor,
  isMaintainerOnlyCommand,
  parseAgentCommandFeedbackContext,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
  githubCommandsInternals,
} from "../../src/github/commands";

describe("GitHub mention commands", () => {
  it("parses only explicit @gittensory commands", () => {
    expect(parseGittensoryMentionCommand(null)).toBeNull();
    expect(parseGittensoryMentionCommand("@gittensory")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("@gittensory ask   ")).toMatchObject({ name: "ask", question: undefined });
    expect(parseGittensoryMentionCommand("@gittensory ask what should I fix first?")).toMatchObject({
      name: "ask",
      question: "what should I fix first?",
    });
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
    // gate-override is an action command: it must be recognized (NOT downgraded to "help") and carry the
    // trailing free text as its reason.
    expect(parseGittensoryMentionCommand("@gittensory gate-override")).toMatchObject({ name: "gate-override", reason: undefined });
    expect(parseGittensoryMentionCommand("@gittensory gate-override known false positive, shipping")).toMatchObject({
      name: "gate-override",
      reason: "known false positive, shipping",
    });
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
    expect(body).toContain("<!-- gittensory-pr-panel:v1 -->");
    expect(body).toContain("| Scope | this repository#12 |");
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
    // PLURAL banned terms must also be redacted — the old `\b(wallet|hotkey|coldkey|...)\b` left the trailing
    // `s` so plurals leaked to public comments (#review-audit).
    expect(sanitizePublicComment("the coldkeys, wallets, hotkeys, mnemonics, seed phrases, and payouts are exposed")).not.toMatch(
      /coldkeys?|wallets?|hotkeys?|mnemonics?|seed phrases?|payouts?/i,
    );
    expect(sanitizePublicComment("raw trust scores and trust scores")).not.toMatch(/trust scores?/i);
    expect(sanitizePublicComment("public score estimate and scoreability should stay private")).not.toMatch(/public score estimate|scoreability/i);
    expect(sanitizePublicComment("public score estimate private scoreability context score preview")).not.toMatch(/public score estimate|scoreability|score preview/i);
    expect(sanitizePublicComment("projected score changes 12.3 -> 45.6")).not.toMatch(/projected score changes|12\.3|45\.6/i);
    expect(sanitizePublicComment("effective score 0 -> 42")).not.toMatch(/effective score|0|42/i);
    // The score engine (buildGateDeltas) emits the "estimated score N -> M" wording — the raw numbers must
    // be redacted too, not just the words (the catch-all also clears residual numbers from other phrases).
    expect(sanitizePublicComment("Open PR pressure changes estimated score 32.5 -> 41.2.")).not.toMatch(/estimated score|32\.5|41\.2/i);
    expect(sanitizePublicComment("Linked issue/no-issue context changes estimated score 18 -> 27.")).not.toMatch(/estimated score|18|27/i);
    expect(sanitizePublicComment("score estimate 5 → 9")).not.toMatch(/score estimate|\b5\b|\b9\b/i);
    expect(sanitizePublicComment("Open PR count 7 exceeds threshold 3.")).not.toMatch(/open PR count|7|threshold|3/i);
    expect(sanitizePublicComment("Credibility 0.12 is below floor 0.4.")).not.toMatch(/credibility|0\.12|floor|0\.4/i);
    expect(sanitizePublicComment("open_pr_pressure closed_pr_credibility low_credibility credibility updates")).not.toMatch(/open_pr_pressure|closed_pr_credibility|low_credibility|credibility/i);
    expect(sanitizePublicComment("Command: @gittensory reviewability")).toContain("@gittensory reviewability");
    expect(sanitizePublicComment("private ranking, wallet, payout")).toBe("private context");
  });

  it("redacts private score projection deltas from public command rerun guidance", () => {
    const baseBundle = sampleBundle();
    const bundle = {
      ...baseBundle,
      actions: [
        {
          ...baseBundle.actions[0]!,
          actionType: "prepare_pr_packet" as const,
          publicSafeSummary: "Prepare public PR packet after validation completes.",
          rerunWhen:
            "Rerun after pending PRs merge/close or after open PR count is at or below 3; projected score changes 12.3 -> 45.6.",
        },
      ],
    };

    for (const mention of ["@gittensory preflight", "@gittensory reviewability", "@gittensory packet"]) {
      const body = buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(mention)!,
        repo: { fullName: "owner/repo" } as any,
        issue: { number: 12, title: "PR", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "author",
        bundle,
      });

      expect(body).toContain("Rerun when:");
      expect(body).toContain("private context");
      expect(body).not.toMatch(/projected score changes|12\.3|45\.6/i);
    }
  });

  it("adds parseable aggregate-only feedback context without public leak terms", () => {
    const body = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 12, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      answerId: "answer_1234",
      bundle: sampleBundle(),
    });

    expect(body).toContain(buildAgentCommandFeedbackMarker("answer_1234"));
    expect(body).toContain("thumbs-up or thumbs-down reaction");
    expect(parseAgentCommandFeedbackContext(body)).toEqual({ answerId: "answer_1234", command: "preflight" });
    expect(parseAgentCommandFeedbackContext(null)).toBeNull();
    expect(parseAgentCommandFeedbackContext("<!-- gittensory-agent-command-answer:answer_1234 -->")).toEqual({ answerId: "answer_1234", command: null });
    expect(parseAgentCommandFeedbackContext("<!-- gittensory-agent-command-answer:answer_1234 -->\nCommand: `@gittensory UNKNOWN`")).toEqual({ answerId: "answer_1234", command: null });
    expect(parseAgentCommandFeedbackContext("missing marker")).toBeNull();
    expect(parseAgentCommandFeedbackContext("<!-- gittensory-agent-command-answer:bad<script> -->")).toBeNull();
    expect(body).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
  });

  it("does not publish repo outcome-pattern details in duplicate-check comments", () => {
    const body = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 99, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-duplicate-outcome-pattern"),
        actions: [
          {
            id: "repo-outcome-pattern-action",
            runId: "run-duplicate-outcome-pattern",
            actionType: "check_duplicate_risk" as const,
            status: "recommended" as const,
            recommendation: "Open direct PR",
            why: [
              "PRs touching duplicate/ have high closure risk here (0/3 merged).",
              'PRs labeled "wip" merge well here (3/3 merged).',
            ],
            blockedBy: [],
            riskImpact: "PRs touching collision/ have high closure risk here (0/3 merged).",
            publicSafeSummary: "Consider a narrow public-safe change.",
            approvalRequired: true,
            safetyClass: "private" as const,
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "duplicate outcome-pattern guard",
      },
    });

    expect(body).toContain("**Duplicate & WIP caution**");
    expect(body).toContain("Consider a narrow public-safe change.");
    expect(body).not.toContain("PRs touching duplicate/");
    expect(body).not.toContain("high closure risk here (0/3 merged)");
    expect(body).not.toContain("merge well here (3/3 merged)");
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
    expect(preflight).toContain("**Gittensory preflight**");
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
    expect(blockers).toContain("**Gittensory readiness blockers**");
    expect(blockers).toContain("**Readiness blockers**");
    expect(blockers).toContain("Resolve queue pressure before opening more work.");
    expect(blockers).toContain("Private readiness context available in authenticated Gittensory views");
    expect(blockers).not.toContain("5 open PR(s)");

    const duplicateCheck = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 12, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: duplicateBundle(),
    });
    expect(duplicateCheck).toContain("**Gittensory duplicate & WIP check**");
    expect(duplicateCheck).toContain("**Duplicate & WIP caution**");
    expect(duplicateCheck).toContain("Possible overlap with existing work");
    expect(duplicateCheck).not.toMatch(/\blikely_duplicate\b/i);

    const nextAction = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 13, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle,
    });
    expect(nextAction).toContain("**Gittensory next step**");
    expect(nextAction).toContain("**Recommended next step**");
    expect(nextAction).toContain("After tests pass.");

    const ask = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what should I improve for contribution quality?")!,
      repo: null,
      issue: { number: 14, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: askCitedBundle(),
    });
    expect(ask).toContain("**Gittensory contribution context Q&A**");
    expect(ask).toContain("**Contribution context Q&A**");
    expect(ask).toContain("Question: what should I improve for contribution quality?");
    const askFindings = publicCardFindings(ask);
    expect(askFindings).toContain("Source: contributor decision pack snapshot; freshness: fresh");
    expect(askFindings).toContain("Source: cached GitHub open PR/issue queue; freshness: fresh");
    expect(askFindings).toContain("Source: cached GitHub issues, PRs, reviews, and checks; freshness: fresh");
    expect(askFindings).toContain("Source: official Gittensor API/cache; freshness: fresh");
    expect(askFindings).toContain("signal data-quality status; freshness:");
    expect(ask).toMatch(/Connected source contributor decision pack snapshot: freshness fresh/);
    expect(ask).toContain("README/docs context is included only when connected repo sources");
    expect(ask).not.toContain("source: action choose_next_work");
    expect(ask).not.toContain("**Source coverage**");
    expect(ask).not.toContain("**Citations**");
    expect(ask).toContain("contributor decision pack snapshot");
    expect(ask).toContain("cached GitHub open PR/issue queue");
    expect(ask).toContain("Freshness: agent run status completed.");

    const askWithTargets = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what should I clean up before review?")!,
      repo: null,
      issue: { number: 15, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: askCitedBundle({
        actions: [
          {
            id: "ask-target-action",
            runId: "run-ask-cited",
            actionType: "prepare_pr_packet",
            targetRepoFullName: "owner/repo",
            targetPullNumber: 88,
            targetIssueNumber: 34,
            status: "recommended",
            recommendation: "Prepare packet",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Prepare a concise packet and verify linked context.",
            approvalRequired: false,
            safetyClass: "public_safe",
            payload: {
              recommendationEvidence: {
                confidence: "high",
                sourceSummary: "Packet evidence",
                freshness: "fresh",
                sources: [
                  {
                    name: "repo_focus_manifest",
                    source: "github_cache",
                    generatedAt: "2026-06-01T12:00:00.000Z",
                    freshness: "fresh",
                    summary: "Repo focus manifest for owner/repo.",
                  },
                ],
              },
            },
          },
        ],
      }),
    });
    expect(publicCardFindings(askWithTargets)).toContain("Source: repo focus manifest; freshness: fresh");
    expect(askWithTargets).toContain("owner/repo: Prepare a concise packet and verify linked context.");
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
    expect(body).toContain("Private readiness context available in authenticated Gittensory views");
    expect(body).not.toMatch(/closed_pr_credibility|low_credibility|credibility/i);
    expect(body).not.toMatch(/open_pr_pressure|closed_pr_credibility|low_credibility|5 open PR\(s\)|Closed PR rate is 48%|Official repo credibility is 0\.42/i);
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
    expect(minerContext).toContain("| Scope | owner/repo#22 |");

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

    const askRefresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask should I update linked issue context?")!,
      repo: null,
      issue: { number: 35, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-ask-refresh",
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
    const askRefreshFindings = publicCardFindings(askRefresh);
    expect(askRefreshFindings).toContain("Contribution context snapshot refresh");
    expect(askRefreshFindings).toContain("Try @gittensory ask again shortly");
    expect(askRefresh).not.toMatch(/next-action snapshot refresh/i);
    expect(askRefresh).toContain("Retry @gittensory ask after the contribution context snapshot refresh completes.");
    expect(askRefresh).toContain("Freshness: contribution context snapshot refresh in progress.");

    const nextActionRefresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 36, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: refreshBundle(),
    });
    expect(nextActionRefresh).toContain("**Next-action snapshot refresh**");

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

    const askNoQuestion = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask")!,
      repo: null,
      issue: { number: 36, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-ask-empty",
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
    expect(askNoQuestion).toContain("No specific question was provided");
    expect(askNoQuestion).toContain("No matching contribution-quality context is available");

    const askMetadata = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what blocks contribution readiness?")!,
      repo: null,
      issue: { number: 37, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-ask-meta"),
        actions: [
          {
            id: "ask-meta-action",
            runId: "run-ask-meta",
            actionType: "explain_score_blockers",
            status: "blocked",
            recommendation: "Resolve blockers",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Resolve queue pressure before opening more work.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {
              recommendationEvidence: {
                confidence: "low",
                sourceSummary: "Mixed metadata",
                freshness: "stale",
                sources: [null, []],
              },
            },
          },
        ],
        contextSnapshots: [
          {
            id: "snap-ask-meta",
            runId: "run-ask-meta",
            repoSignalSnapshotIds: [],
            freshnessWarnings: ["decision pack is stale; rebuild enqueued"],
            payload: {
              baseFreshness: { status: "stale", observedAt: "2026-06-01T10:00:00.000Z" },
              branchEligibility: { stale: true },
              scoreabilityStatus: "blocked",
              dataQuality: { status: "partial" },
              evidenceGraph: {
                sources: [null, "invalid", { detail: "Graph source without explicit origin." }],
              },
            },
          },
          {
            id: "snap-ask-meta-missing",
            runId: "run-ask-meta",
            repoSignalSnapshotIds: [],
            freshnessWarnings: ["partial signal coverage only"],
            payload: {
              branchEligibility: { evidence: "missing" },
              scoreabilityStatus: "ready",
              baseFreshness: {},
            },
          },
          {
            id: "snap-ask-meta-fresh",
            runId: "run-ask-meta",
            repoSignalSnapshotIds: [],
            freshnessWarnings: [],
            payload: {
              branchEligibility: { stale: false, evidence: "present" },
            },
          },
          {
            id: "snap-ask-meta-graph-shape",
            runId: "run-ask-meta",
            repoSignalSnapshotIds: [],
            freshnessWarnings: [],
            payload: {
              evidenceGraph: { sources: "not-an-array" },
            },
          },
        ],
        summary: "ask metadata",
      },
    });
    expect(askMetadata).toContain("repo sync freshness metadata");
    expect(askMetadata).toContain("branch eligibility metadata");
    expect(askMetadata).not.toContain("Contribution readiness status");
    expect(publicCardFindings(askMetadata)).toContain("freshness: partial");
    expect(askMetadata).not.toContain("No concrete cached source reference is available for this response.");

    const askNoSources = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what is the repo policy?")!,
      repo: null,
      issue: { number: 38, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
    });
    expect(askNoSources).toContain("cached Gittensory agent context (no connected-source metadata in this run)");

    const askEvidenceOnly = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what should I verify locally?")!,
      repo: null,
      issue: { number: 39, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-ask-evidence-only"),
        actions: [
          {
            id: "ask-evidence-only",
            runId: "run-ask-evidence-only",
            actionType: "preflight_branch",
            status: "ready",
            recommendation: "Preflight",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Run local branch preflight first.",
            approvalRequired: false,
            safetyClass: "private",
            payload: {
              recommendationEvidence: {
                confidence: "medium",
                sourceSummary: "Branch metadata",
                freshness: "fresh",
                sources: [{ name: "custom_unknown_source" }],
              },
            },
          },
        ],
        contextSnapshots: [],
        summary: "ask evidence only",
      },
    });
    expect(askEvidenceOnly).toContain("Source: custom unknown source; freshness:");
    expect(askEvidenceOnly).toContain("custom unknown source");

    const askFallbackCitations = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what is missing?")!,
      repo: null,
      issue: { number: 40, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-ask-fallback-citations"),
        actions: [
          {
            id: "ask-fallback-citations",
            runId: "run-ask-fallback-citations",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "Next",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Use cached queue context before opening new work.",
            approvalRequired: false,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "ask fallback citations",
      },
    });
    expect(askFallbackCitations).toContain("No concrete cached source reference is available for this response.");
    expect(publicCardFindings(askFallbackCitations)).toContain("No concrete cached source reference is available for this response.");
    const askFallbackDetails = askFallbackCitations.slice(askFallbackCitations.indexOf("Additional safe details"));
    expect(askFallbackDetails).toContain("README/docs context is included only when connected repo sources");
    expect(askFallbackDetails).not.toMatch(/origin: /);

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
    expect(withPrFallbackScope).toContain("| Scope | owner/from-pr#5 |");
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
    expect(blockersWithDuplicateCodes.match(/Private readiness context available in authenticated Gittensory views/g)).toHaveLength(1);

    const blockersFromStatus = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 25, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-blockers-status"),
        actions: [
          {
            id: "blocker-status",
            runId: "run-blockers-status",
            actionType: "monitor_existing_pr",
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
    expect(blockersFromStatus.match(/Private readiness context available in authenticated Gittensory views/g)).toHaveLength(1);

    const statusOnlyBlocker = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 26, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-blockers-status-only"),
        actions: [
          {
            id: "blocker-status-only",
            runId: "run-blockers-status-only",
            actionType: "monitor_existing_pr",
            status: "blocked",
            recommendation: "Wait",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Wait for maintainer review capacity.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "blockers",
      },
    });
    expect(statusOnlyBlocker).toContain("Wait for maintainer review capacity.");

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
    expect(duplicateViaRecommendation).toContain("Review linked issues before requesting detailed review.");
    expect(duplicateViaRecommendation).not.toContain("Concurrent review pressure");

    const duplicateWithInjectedWhy = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-check")!,
      repo: null,
      issue: { number: 27, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      bundle: {
        run: completedRun("run-duplicate-injection"),
        actions: [
          {
            id: "duplicate-injection",
            runId: "run-duplicate-injection",
            actionType: "monitor_existing_pr",
            status: "watch",
            recommendation: "Compare duplicate risk",
            why: ["PRs touching duplicate\n@octo-team/ [click](https://example.test) have high closure risk here."],
            blockedBy: [],
            riskImpact: "No extra risk",
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
    expect(duplicateWithInjectedWhy).not.toContain("PRs touching duplicate");
    expect(duplicateWithInjectedWhy).not.toMatch(/\n@octo-team|@octo-team|[^\\]\[click\]\(https:\/\/example\.test\)/);

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
    expect(preflightWithRerun).toContain("Private readiness context available in authenticated Gittensory views");

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
    expect(duplicateBlockerLabels.match(/Private readiness context available in authenticated Gittensory views/g)).toHaveLength(1);

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
    expect(reviewability).toContain("**Gittensory PR readiness**");
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
    expect(repoFit).toContain("**Gittensory repository fit**");
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
    expect(packet).toContain("**Gittensory public packet**");
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
    expect(duplicateBlockers.match(/Private readiness context available in authenticated Gittensory views/g)).toHaveLength(1);
  });

  it("renders the new maintainer intelligence commands public-safely", () => {
    const digest = sampleMaintainerDigest();
    expect(digest.burdenForecast.repoFullName).toBe("owner/repo");
    expect(digest.intakeHealth.repoFullName).toBe("owner/repo");
    expect(digest.outcomePatterns.repoFullName).toBe("owner/repo");
    expect(digest.noiseReport.repoFullName).toBe("owner/repo");

    const FORBIDDEN = /wallet|hotkey|coldkey|mnemonic|raw trust score|trust score|payout|reward estimate|farming|private reviewability|scoreability/i;
    const render = (mention: string) =>
      buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(mention)!,
        repo: { fullName: "owner/repo" } as any,
        issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "maintainer",
        maintainerDigest: digest,
      });

    const burden = render("@gittensory burden-forecast");
    expect(burden).toContain("**Gittensory burden forecast**");
    expect(burden).toContain("**Burden forecast**");
    expect(burden).toContain("Forecast level:");
    expect(burden).not.toMatch(FORBIDDEN);

    const intake = render("@gittensory intake-health");
    expect(intake).toContain("**Contributor intake health**");
    expect(intake).toContain("Intake level:");
    expect(intake).not.toMatch(FORBIDDEN);

    const outcomes = render("@gittensory outcome-patterns");
    expect(outcomes).toContain("**Outcome patterns**");
    expect(outcomes).toContain("Lane:");
    expect(outcomes).not.toMatch(FORBIDDEN);

    const noise = render("@gittensory noise-report");
    expect(noise).toContain("**Noise report**");
    expect(noise).toContain("Noise level:");
    expect(noise).not.toMatch(FORBIDDEN);

    expect(parseGittensoryMentionCommand("@gittensory burden-forecast")?.name).toBe("burden-forecast");
    expect(isMaintainerOnlyCommand("noise-report")).toBe(true);
  });

  it("renders populated and empty outcome/noise report variants", () => {
    const base = sampleMaintainerDigest();
    const render = (mention: string, digest: typeof base) =>
      buildPublicAgentCommandComment({
        command: parseGittensoryMentionCommand(mention)!,
        repo: { fullName: "owner/repo" } as any,
        issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
        pullRequest: null,
        actorKind: "maintainer",
        maintainerDigest: digest,
      });

    const populated = {
      ...base,
      outcomePatterns: {
        ...base.outcomePatterns,
        successPatterns: [{ title: "Linked + tested", detail: "Merged PRs link an issue and include validation notes.", confidence: "high" as const }],
        riskPatterns: [{ title: "Unlinked churn", detail: "Closed PRs often lacked a linked issue.", confidence: "medium" as const }],
      },
      noiseReport: { ...base.noiseReport, noiseSources: ["3 open PR(s) lack linked issue context."], maintainerActions: ["needs_author" as const, "review_now" as const] },
    };
    const populatedOutcomes = render("@gittensory outcome-patterns", populated);
    expect(populatedOutcomes).toContain("Merges when:");
    expect(populatedOutcomes).toContain("Closes when:");
    const populatedNoise = render("@gittensory noise-report", populated);
    expect(populatedNoise).toContain("lack linked issue context");
    expect(populatedNoise).toContain("Suggested triage:");

    const empty = {
      ...base,
      outcomePatterns: { ...base.outcomePatterns, successPatterns: [], riskPatterns: [] },
      noiseReport: { ...base.noiseReport, noiseSources: [], maintainerActions: [] },
    };
    const emptyOutcomes = render("@gittensory outcome-patterns", empty);
    expect(emptyOutcomes).not.toContain("Merges when:");
    expect(emptyOutcomes).not.toContain("Closes when:");
    const emptyNoise = render("@gittensory noise-report", empty);
    expect(emptyNoise).toContain("No obvious queue noise source");
    expect(emptyNoise).not.toContain("Suggested triage:");
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
    expect(queueSummary).toContain("**Gittensory maintainer queue summary**");
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

    const unavailableDigest = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory review-now")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 102, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: null,
    });
    expect(unavailableDigest).toContain("Cached queue context is unavailable for this command.");

    const emptyReviewNow = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory review-now")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 103, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: { ...digest, reviewNowPullRequests: [] },
    });
    expect(emptyReviewNow).toContain("No cached PR currently looks ready for detailed review.");

    const emptyDuplicateClusters = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-clusters")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 104, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: { ...digest, duplicateClusters: [] },
    });
    expect(emptyDuplicateClusters).toContain("No duplicate or WIP cluster is visible from cached metadata.");

    const emptyConfirmed = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory confirmed-miners")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 105, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: { ...digest, confirmedMinerPullRequests: [] },
    });
    expect(emptyConfirmed).toContain("No cached confirmed-miner PRs are visible in this queue.");

    const emptyNeedsAuthor = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory needs-author")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 106, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: { ...digest, needsAuthorPullRequests: [] },
    });
    expect(emptyNeedsAuthor).toContain("No cached PR currently needs obvious author cleanup first.");
  });

  it("neutralizes attacker-controlled queue digest titles in public comments", () => {
    const attackerTitle = "[x](http://e.test) ![i](http://e.test/i) @org/team <b>x</b>";
    const digest = {
      ...sampleMaintainerDigest(),
      reviewNowPullRequests: [
        {
          number: 77,
          title: attackerTitle,
          authorLogin: "attacker",
          linkedIssues: [7],
          labels: [],
          confirmedMiner: false,
          ageDays: 0,
          reasons: ["Linked issue is present."],
          signals: [],
        },
      ],
      duplicateClusters: [
        {
          id: "attacker-title",
          risk: "high",
          reason: "Likely_duplicate title cluster",
          items: [{ type: "pull_request", number: 77, title: attackerTitle }],
        },
      ],
    } satisfies ReturnType<typeof sampleMaintainerDigest>;

    const reviewNow = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory review-now")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });
    const duplicateClusters = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory duplicate-clusters")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 99, title: "Digest", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
      maintainerDigest: digest,
    });

    for (const body of [reviewNow, duplicateClusters]) {
      expect(body).not.toContain("[x](http://e.test)");
      expect(body).not.toContain("![i](http://e.test/i)");
      expect(body).not.toContain("@org/team");
      expect(body).not.toContain("<b>x</b>");
      expect(body).toContain("\\[x\\]");
      expect(body).toContain("@\u200Borg/team");
      expect(body).toContain("&lt;b&gt;x&lt;/b&gt;");
    }
  });

  it("falls back to repository placeholder when queue digest has no source records", () => {
    const digest = buildMaintainerQueueDigest({
      repo: null,
      issues: [],
      pullRequests: [],
      recentMergedPullRequests: [],
    });
    expect(digest.repoFullName).toBe("this repository");
    expect(digest.reviewNowPullRequests).toHaveLength(0);
    expect(digest.needsAuthorPullRequests).toHaveLength(0);
  });
});

describe("ask citation helpers", () => {
  it("uses contribution-context refresh wording for ask snapshot rebuilds", () => {
    const refresh = githubCommandsInternals.refreshSections("ask");
    expect(refresh.join("\n")).toContain("Contribution context snapshot refresh");
    expect(refresh.join("\n")).toContain("Try @gittensory ask again shortly");
    expect(refresh.join("\n")).not.toContain("next-action");

    const sections = githubCommandsInternals.askSections(
      {
        run: { ...completedRun("run-ask-sections"), status: "needs_snapshot_refresh" },
        actions: [],
        contextSnapshots: [],
        summary: "refresh",
      },
      "What should I fix?",
    );
    expect(sections.join("\n")).toContain("Try @gittensory ask again shortly");
  });

  it("does not publish private repo decision ranking evidence in ask citations", () => {
    const bundle = askCitedBundle({
      actions: [
        {
          id: "ask-private-decision-action",
          runId: "run-ask-cited",
          actionType: "choose_next_work",
          status: "recommended",
          recommendation: "recommendation",
          why: [],
          blockedBy: [],
          targetRepoFullName: "owner/private-repo",
          publicSafeSummary: "Run local branch preflight first.",
          approvalRequired: true,
          safetyClass: "private",
          payload: {
            recommendationEvidence: {
              confidence: "high",
              sourceSummary: "Decision pack evidence",
              freshness: "fresh",
              sources: [
                {
                  name: "repo_decision",
                  source: "decision_pack",
                  generatedAt: "2026-06-01T12:00:00.000Z",
                  freshness: "fresh",
                  summary: "owner/private-repo ranked pursue_now at priority 0.87321.",
                },
                {
                  name: "open_pr_monitor",
                  source: "github_cache",
                  generatedAt: "2026-06-01T12:00:00.000Z",
                  freshness: "fresh",
                  summary: "Open PR monitor queue metadata.",
                },
              ],
            },
          },
        },
      ],
      contextSnapshots: [],
    });

    const sources = githubCommandsInternals.collectAskContributingSources(bundle);
    expect(sources.some((source) => source.origin === "repo_decision")).toBe(false);
    expect(sources.find((source) => source.origin === "open_pr_monitor")?.detail).toBe(
      "Cached open PR and issue queue metadata was available for this cached agent run.",
    );

    const comment = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what should I do next?")!,
      repo: null,
      issue: { number: 44, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle,
    });
    expect(comment).toContain("Source: cached GitHub open PR/issue queue; freshness: fresh");
    expect(comment).not.toMatch(/ranked|pursue_now|priority 0\.87321/i);
    expect(comment).not.toContain("owner/private-repo ranked");
  });

  it("collects connected-source metadata and formats concrete citations", () => {
    const sources = githubCommandsInternals.collectAskContributingSources({
      run: completedRun("run-ask-internals"),
      actions: [
        {
          id: "ask-internal-action",
          runId: "run-ask-internals",
          actionType: "choose_next_work",
          status: "recommended",
          recommendation: "Next",
          why: [],
          blockedBy: [],
          publicSafeSummary: "Use cached queue context.",
          approvalRequired: false,
          safetyClass: "private",
          payload: {
            recommendationEvidence: {
              sources: [{ name: "score_preview" }, null],
            },
          },
        },
      ],
      contextSnapshots: [
        {
          id: "snap-ask-internals",
          runId: "run-ask-internals",
          repoSignalSnapshotIds: [],
          freshnessWarnings: ["partial signal coverage only"],
          decisionPackVersion: "2026-06-01T12:00:00.000Z",
          payload: {
            branchEligibility: { stale: false, evidence: "present" },
            scoreabilityStatus: "ready",
            evidenceGraph: { sources: [{ source: "computed", freshness: "partial", detail: "Derived contributor signals." }] },
            baseFreshness: {},
          },
        },
      ],
      summary: "internals",
    });
    expect(sources.map((source) => source.key)).toEqual(
      expect.arrayContaining(["branch_eligibility", "base_freshness", "evidence_graph_computed"]),
    );
    expect(sources.some((source) => source.key === "scoreability_status" || source.key === "score_preview")).toBe(false);
    expect(sources.find((source) => source.key === "branch_eligibility")?.freshness).toBe("fresh");
    expect(
      githubCommandsInternals.snapshotFreshnessFromWarnings({
        id: "snap",
        runId: "run-ask-internals",
        repoSignalSnapshotIds: [],
        freshnessWarnings: ["partial signal coverage only"],
        payload: {},
      }),
    ).toBe("fresh");
    expect(
      githubCommandsInternals.snapshotFreshnessFromWarnings({
        id: "snap-stale",
        runId: "run-ask-internals",
        repoSignalSnapshotIds: [],
        freshnessWarnings: ["decision pack is stale; rebuild enqueued"],
        payload: {},
      }),
    ).toBe("stale");
    expect(githubCommandsInternals.formatAskCitation(sources[0]!)).toContain("Source:");
    expect(
      githubCommandsInternals.formatAskCitation({
        key: "empty-detail",
        label: "metadata-only source",
        origin: "metadata_only",
        generatedAt: null,
        freshness: "unknown",
        detail: "",
      }),
    ).toBe("- Source: metadata-only source; freshness: unknown.");

    const extended = githubCommandsInternals.collectAskContributingSources({
      run: completedRun("run-ask-internals-extended"),
      actions: [],
      contextSnapshots: [
        {
          id: "snap-extended",
          runId: "run-ask-internals-extended",
          repoSignalSnapshotIds: [],
          freshnessWarnings: ["decision pack is stale; rebuild enqueued"],
          payload: {
            source: "gittensor_api",
            openPrMonitor: {},
            branchEligibility: { evidence: "missing" },
            dataQuality: { signalFidelity: { status: "partial" } },
            evidenceGraph: {
              sources: [{ source: "mirror" }, { source: "repo_focus_manifest", freshness: "stale", generatedAt: "2026-06-01T11:00:00.000Z" }],
            },
          },
        },
      ],
      summary: "extended",
    });
    expect(extended.find((source) => source.key === "branch_eligibility")?.freshness).toBe("missing");
    expect(extended.some((source) => source.label.includes("Gittensor mirror registry snapshot"))).toBe(true);
    expect(extended.some((source) => source.detail.includes("metadata was available"))).toBe(true);
    expect(extended.some((source) => source.key === "freshness_warnings")).toBe(true);
    expect(extended.some((source) => source.key === "contributor_decision_pack" && source.detail.includes("Contributor decision-pack metadata"))).toBe(true);
    expect(extended.find((source) => source.key === "open_pr_monitor")?.freshness).toBe("unknown");

    const askOverflow = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask list every connected source?")!,
      repo: null,
      issue: { number: 41, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: askCitedBundle(),
    });
    expect(askOverflow).toContain("<summary>Additional safe details</summary>");
    expect(askOverflow).toContain("Source: cached GitHub open PR/issue queue; freshness:");

    const askWithoutTimestamps = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what is synced?")!,
      repo: null,
      issue: { number: 42, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-ask-no-ts"),
        actions: [],
        contextSnapshots: [
          {
            id: "snap-no-ts",
            runId: "run-ask-no-ts",
            repoSignalSnapshotIds: [],
            freshnessWarnings: [],
            payload: { baseFreshness: {}, openPrMonitor: {} },
          },
        ],
        summary: "no timestamps",
      },
    });
    expect(askWithoutTimestamps).toContain("Connected source repo sync freshness metadata: freshness unknown.");
    expect(askWithoutTimestamps).not.toContain("freshness unknown as of");

    const askFourSources = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory ask what sources apply?")!,
      repo: null,
      issue: { number: 43, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: completedRun("run-ask-four"),
        actions: [],
        contextSnapshots: [
          {
            id: "snap-four",
            runId: "run-ask-four",
            repoSignalSnapshotIds: [],
            freshnessWarnings: [],
            payload: {
              evidenceGraph: {
                sources: [
                  { source: "github_cache", freshness: "fresh", generatedAt: "2026-06-01T12:00:00.000Z", detail: "a" },
                  { source: "official_gittensor", freshness: "fresh", generatedAt: "2026-06-01T12:00:00.000Z", detail: "b" },
                  { source: "mirror", freshness: "fresh", generatedAt: "2026-06-01T12:00:00.000Z", detail: "c" },
                  { source: "computed", freshness: "fresh", generatedAt: "2026-06-01T12:00:00.000Z", detail: "d" },
                ],
              },
            },
          },
        ],
        summary: "four sources",
      },
    });
    const fourDetails = askFourSources.slice(askFourSources.indexOf("Additional safe details"));
    expect(fourDetails).toContain("README/docs context is included only when connected repo sources");
    expect(fourDetails).not.toMatch(/origin: computed/);
  });
});

function publicCardFindings(comment: string): string {
  const start = comment.indexOf("**Findings**");
  const end = comment.indexOf("**Evidence**");
  if (start < 0 || end < 0 || end <= start) return comment;
  return comment.slice(start, end);
}

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

function askCitedBundle(overrides: { actions?: Array<Record<string, unknown>>; contextSnapshots?: Array<Record<string, unknown>> } = {}): import("../../src/services/agent-orchestrator").AgentRunBundle {
  return {
    run: completedRun("run-ask-cited"),
    actions: [
      {
        id: "ask-cited-action",
        runId: "run-ask-cited",
        actionType: "choose_next_work" as const,
        status: "recommended" as const,
        recommendation: "recommendation",
        why: [],
        blockedBy: [],
        publicSafeSummary: "Run local branch preflight first.",
        rerunWhen: "After tests pass.",
        approvalRequired: true,
        safetyClass: "private" as const,
        payload: {
          recommendationEvidence: {
            confidence: "high",
            sourceSummary: "Decision pack evidence",
            freshness: "fresh",
            sources: [
              {
                name: "contributor_decision_pack",
                source: "gittensor_api",
                generatedAt: "2026-06-01T12:00:00.000Z",
                freshness: "fresh",
                summary: "oktofeesh1 decision pack with complete signal fidelity.",
              },
              {
                name: "open_pr_monitor",
                source: "github_cache",
                generatedAt: "2026-06-01T12:00:00.000Z",
                freshness: "fresh",
                summary: "Open PR monitor queue metadata.",
              },
            ],
          },
        },
      },
    ],
    contextSnapshots: [
      {
        id: "snap-ask-cited",
        runId: "run-ask-cited",
        decisionPackVersion: "2026-06-01T12:00:00.000Z",
        repoSignalSnapshotIds: [],
        freshnessWarnings: [],
        payload: {
          evidenceGraph: {
            generatedAt: "2026-06-01T12:00:00.000Z",
            sources: [
              {
                source: "github_cache",
                freshness: "fresh",
                generatedAt: "2026-06-01T12:00:00.000Z",
                detail: "Cached GitHub issues, pull requests, reviews, and checks.",
              },
              {
                source: "official_gittensor",
                freshness: "fresh",
                generatedAt: "2026-06-01T12:00:00.000Z",
                detail: "Official Gittensor contributor snapshot.",
              },
            ],
          },
          dataQuality: {
            status: "complete",
            signalFidelity: { status: "complete" },
          },
        },
      },
    ],
    summary: "ask cited",
    ...overrides,
  } as import("../../src/services/agent-orchestrator").AgentRunBundle;
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
