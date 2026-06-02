import { describe, expect, it } from "vitest";
import {
  createAgentRun,
  getAgentRecommendationOutcomeSummary,
  listAgentRecommendationOutcomes,
  persistAgentContextSnapshot,
  recordAgentCommandFeedback,
  replaceAgentActions,
  upsertAgentCommandAnswer,
  upsertAgentRecommendationOutcome,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
} from "../../src/db/repositories";
import { classifyRecommendationOutcome, evaluateRecommendationOutcomes, recordExplicitRecommendationFeedbackOutcome } from "../../src/services/recommendation-outcomes";
import type { AgentActionRecord, AgentContextSnapshotRecord, AgentRunRecord, GitHubIssuePayload, GitHubPullRequestPayload, IssueRecord, PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("recommendation outcome feedback", () => {
  it("matches later PR and issue outcomes while separating maintainer-lane activity", async () => {
    const env = createTestEnv();
    const run = runRecord("run-outcomes", "dev", "2026-05-01T00:00:00.000Z");
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [
      action(run, 0, { targetRepoFullName: "owner/merged" }),
      action(run, 1, { targetRepoFullName: "owner/closed", targetPullNumber: 12 }),
      action(run, 2, { targetRepoFullName: "owner/stale", targetPullNumber: 13 }),
      action(run, 3, { targetRepoFullName: "owner/ignored" }),
      action(run, 4, { targetRepoFullName: "owner/issue", targetIssueNumber: 7 }),
      action(run, 5, { targetRepoFullName: "owner/improved", targetPullNumber: 14 }),
      action(run, 6, { targetRepoFullName: "dev/own" }),
    ]);

    await upsertPullRequestFromGitHub(env, "owner/merged", pr(11, { state: "closed", merged_at: "2026-05-05T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-05T00:00:00.000Z" }));
    await upsertPullRequestFromGitHub(env, "owner/closed", pr(12, { state: "closed", created_at: "2026-04-20T00:00:00.000Z", updated_at: "2026-05-03T00:00:00.000Z" }));
    await upsertPullRequestFromGitHub(env, "owner/stale", pr(13, { state: "open", created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-04-02T00:00:00.000Z" }));
    await upsertPullRequestFromGitHub(env, "owner/improved", pr(14, { state: "open", created_at: "2026-04-20T00:00:00.000Z", updated_at: "2026-05-03T00:00:00.000Z", reviewDecision: "APPROVED" }));
    await upsertIssueFromGitHub(env, "owner/issue", issue(7, { state: "closed", created_at: "2026-04-20T00:00:00.000Z", updated_at: "2026-05-04T00:00:00.000Z" }));
    await upsertPullRequestFromGitHub(env, "dev/own", pr(21, { state: "closed", merged_at: "2026-05-06T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-06T00:00:00.000Z", author_association: "OWNER" }));

    const result = await evaluateRecommendationOutcomes(env, "dev", { now: "2026-06-01T00:00:00.000Z", staleAfterDays: 14, ignoredAfterDays: 7 });
    expect(result.skippedFreshActions).toBe(0);
    expect(result.outcomes.map((outcome) => [outcome.targetRepoFullName, outcome.outcomeState, outcome.maintainerLane])).toEqual(
      expect.arrayContaining([
        ["owner/merged", "merged", false],
        ["owner/closed", "closed", false],
        ["owner/stale", "stale", false],
        ["owner/ignored", "ignored", false],
        ["owner/issue", "closed", false],
        ["owner/improved", "improved", false],
        ["dev/own", "merged", true],
      ]),
    );

    const summary = await getAgentRecommendationOutcomeSummary(env, "dev", { now: "2026-06-01T00:00:00.000Z", windowDays: 90 });
    expect(summary.totals).toMatchObject({ total: 6, merged: 1, closed: 2, stale: 1, ignored: 1, improved: 1, positive: 2, negative: 4, maintainerLaneTotal: 1 });
    expect(summary.maintainerLane).toMatchObject({ total: 1, states: [{ state: "merged", count: 1 }] });
    expect(summary.repos.find((repo) => repo.repoFullName === "dev/own")).toMatchObject({ total: 0, maintainerLaneTotal: 1, signal: "neutral" });
  });

  it("skips fresh unmatched actions and upserts later terminal outcomes idempotently", async () => {
    const env = createTestEnv();
    const run = runRecord("run-idempotent", "dev", "2026-05-01T00:00:00.000Z");
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [
      action(run, 0, { targetRepoFullName: "owner/later" }),
      action(run, 1, { targetRepoFullName: "owner/fresh", createdAt: "2026-05-30T00:00:00.000Z" }),
    ]);
    await upsertPullRequestFromGitHub(env, "owner/later", pr(31, { state: "open", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-02T00:00:00.000Z" }));

    const accepted = await evaluateRecommendationOutcomes(env, "dev", { now: "2026-06-01T00:00:00.000Z", ignoredAfterDays: 7 });
    expect(accepted.outcomes.map((outcome) => outcome.outcomeState)).toEqual(["accepted"]);
    expect(accepted.skippedFreshActions).toBe(1);

    await upsertPullRequestFromGitHub(env, "owner/later", pr(31, { state: "closed", merged_at: "2026-06-02T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-06-02T00:00:00.000Z" }));
    const merged = await evaluateRecommendationOutcomes(env, "dev", { now: "2026-06-03T00:00:00.000Z", ignoredAfterDays: 7 });

    expect(merged.outcomes.find((outcome) => outcome.targetRepoFullName === "owner/later")).toMatchObject({ outcomeState: "merged", outcomePullNumber: 31 });
    const rows = await listAgentRecommendationOutcomes(env, { actorLogin: "dev" });
    expect(rows.filter((row) => row.targetRepoFullName === "owner/later")).toHaveLength(1);
  });

  it("records explicit accepted and rejected feedback separately from inferred lifecycle outcomes", async () => {
    const env = createTestEnv();
    const run = runRecord("run-explicit-feedback", "dev", "2026-05-01T00:00:00.000Z");
    const usefulAction = action(run, 0, { targetRepoFullName: "owner/useful", targetIssueNumber: 10 });
    const rejectedAction = action(run, 1, { targetRepoFullName: "owner/rejected", targetPullNumber: 20 });
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [usefulAction, rejectedAction]);
    await upsertAgentCommandAnswer(env, answer("answer-useful", "preflight", "owner/useful", 10, { runId: run.id, actionId: usefulAction.id }));
    await upsertAgentCommandAnswer(env, answer("answer-rejected", "preflight", "owner/rejected", 20, { runId: run.id, actionId: rejectedAction.id }));

    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: (await upsertAgentCommandAnswer(env, answer("answer-useful", "preflight", "owner/useful", 10, { runId: run.id, actionId: usefulAction.id }))),
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
        now: "2026-05-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ outcomeState: "accepted", source: "explicit", metadata: { feedbackVote: "useful" } });

    const rejected = await recordExplicitRecommendationFeedbackOutcome(env, {
      answer: (await upsertAgentCommandAnswer(env, answer("answer-rejected", "preflight", "owner/rejected", 20, { runId: run.id, actionId: rejectedAction.id }))),
      vote: "not_useful",
      feedbackSource: "github_reaction",
      actorKind: "author",
      now: "2026-05-02T00:00:00.000Z",
    });
    expect(rejected).toMatchObject({ outcomeState: "rejected", source: "explicit", outcomeTargetType: "pull_request", outcomePullNumber: 20 });

    await upsertPullRequestFromGitHub(env, "owner/rejected", pr(20, { state: "closed", merged_at: "2026-05-03T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-03T00:00:00.000Z" }));
    await evaluateRecommendationOutcomes(env, "dev", { now: "2026-05-04T00:00:00.000Z" });

    const rows = await listAgentRecommendationOutcomes(env, { actorLogin: "dev" });
    expect(rows.find((row) => row.actionId === rejectedAction.id)).toMatchObject({ outcomeState: "rejected", source: "explicit" });
    const summary = await getAgentRecommendationOutcomeSummary(env, "dev", { now: "2026-05-04T00:00:00.000Z" });
    expect(summary.totals).toMatchObject({ total: 2, accepted: 1, positive: 1, negative: 1 });
  });

  it("keeps explicit feedback classification deterministic across fallback and aggregate branches", async () => {
    const env = createTestEnv();
    const run = runRecord("run-explicit-branches", "dev", "2026-05-01T00:00:00.000Z");
    const repoAction = action(run, 0, { targetRepoFullName: "owner/repo-only", targetPullNumber: null, targetIssueNumber: null });
    const noneAction = action(run, 1, { targetRepoFullName: "", targetPullNumber: null, targetIssueNumber: null });
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [repoAction, noneAction]);

    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: answer("answer-missing-run", "preflight", "owner/missing", 1),
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
      }),
    ).resolves.toBeNull();
    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: answer("answer-unknown-run", "preflight", "owner/missing", 1, { runId: "missing-run" }),
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
      }),
    ).resolves.toBeNull();

    const emptyRun = runRecord("run-no-actions", "dev", "2026-05-01T00:00:00.000Z");
    await createAgentRun(env, emptyRun);
    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: answer("answer-no-action", "preflight", "owner/missing", 1, { runId: emptyRun.id }),
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
      }),
    ).resolves.toBeNull();

    const repoAnswer = await upsertAgentCommandAnswer(env, answer("answer-repo-target", "preflight", "owner/repo-only", 0, { runId: run.id, actionId: repoAction.id }));
    await recordAgentCommandFeedback(env, {
      answerId: repoAnswer.id,
      repoFullName: repoAnswer.repoFullName,
      issueNumber: repoAnswer.issueNumber,
      command: repoAnswer.command,
      actorLogin: "reviewer-one",
      vote: "not_useful",
      source: "app",
      actorKind: "maintainer",
      updatedAt: "2026-05-02T00:00:00.000Z",
      metadata: {},
    });
    await recordAgentCommandFeedback(env, {
      answerId: repoAnswer.id,
      repoFullName: repoAnswer.repoFullName,
      issueNumber: repoAnswer.issueNumber,
      command: repoAnswer.command,
      actorLogin: "reviewer-two",
      vote: "useful",
      source: "app",
      actorKind: "maintainer",
      updatedAt: "2026-05-03T00:00:00.000Z",
      metadata: {},
    });
    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: repoAnswer,
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
        now: "2026-05-04T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcomeState: "rejected",
      outcomeTargetType: "repository",
      sourceUpdatedAt: "2026-05-03T00:00:00.000Z",
      metadata: { feedbackCount: 2, usefulCount: 1, notUsefulCount: 1 },
    });

    await expect(
      recordExplicitRecommendationFeedbackOutcome(env, {
        answer: await upsertAgentCommandAnswer(env, answer("answer-none-target", "preflight", "", 0, { runId: run.id, actionId: noneAction.id })),
        vote: "useful",
        feedbackSource: "app",
        actorKind: "maintainer",
      }),
    ).resolves.toMatchObject({ outcomeState: "accepted", outcomeTargetType: "none" });
  });

  it("classifies linked PRs, later issues, payload targets, no-target, and defensive timestamp branches", () => {
    const run = runRecord("run-classifier", "dev", "2026-05-01T00:00:00.000Z");
    const base = {
      run,
      evaluatedAt: "2026-06-01T00:00:00.000Z",
      staleAfterMs: 14 * 24 * 60 * 60 * 1000,
      ignoredAfterMs: 7 * 24 * 60 * 60 * 1000,
    };

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 0, { targetRepoFullName: "owner/linked", targetIssueNumber: 99 }),
        pullRequests: [prRecord(40, "owner/linked", { linkedIssues: [99] })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "accepted", outcomeTargetType: "pull_request", metadata: { matchedBy: "linked_issue_pull_request" } });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 1, { targetRepoFullName: "owner/issues" }),
        pullRequests: [],
        issues: [issueRecord(41, "owner/issues")],
      }),
    ).toMatchObject({ outcomeState: "accepted", outcomeTargetType: "issue", metadata: { matchedBy: "later_repo_issue" } });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 2, { targetRepoFullName: undefined, payload: { decision: { repoFullName: "owner/payload" } } }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeTargetType: "repository", outcomeRepoFullName: "owner/payload", confidence: "medium" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 3, { targetRepoFullName: undefined, payload: { action: { repoFullName: "owner/nested" } } }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeTargetType: "repository", outcomeRepoFullName: "owner/nested" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 4, { targetRepoFullName: undefined, payload: {} }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeTargetType: "none", confidence: "low" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 5, { createdAt: "not-a-date" }),
        pullRequests: [],
        issues: [],
      }),
    ).toBeNull();
  });

  it("classifies non-terminal open targets as stale or ignored from exact cached targets", () => {
    const run = runRecord("run-open-targets", "dev", "2026-05-01T00:00:00.000Z");
    const staleAfterMs = 14 * 24 * 60 * 60 * 1000;

    expect(
      classifyRecommendationOutcome({
        run,
        action: action(run, 0, { targetRepoFullName: "owner/stale-issue", targetIssueNumber: 50 }),
        pullRequests: [],
        issues: [issueRecord(50, "owner/stale-issue", { state: "open", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" })],
        evaluatedAt: "2026-06-01T00:00:00.000Z",
        staleAfterMs,
        ignoredAfterMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toMatchObject({ outcomeState: "stale", outcomeTargetType: "issue" });

    expect(
      classifyRecommendationOutcome({
        run,
        action: action(run, 1, { targetRepoFullName: "owner/ignored-pr", targetPullNumber: 51 }),
        pullRequests: [prRecord(51, "owner/ignored-pr", { state: "open", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" })],
        issues: [],
        evaluatedAt: "2026-05-05T00:00:00.000Z",
        staleAfterMs,
        ignoredAfterMs: 1,
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeTargetType: "pull_request", confidence: "medium" });
  });

  it("does not count terminal target state that predates the recommendation", () => {
    const run = runRecord("run-predated-terminals", "dev", "2026-05-01T00:00:00.000Z");
    const staleAfterMs = 14 * 24 * 60 * 60 * 1000;
    const base = {
      run,
      evaluatedAt: "2026-06-01T00:00:00.000Z",
      staleAfterMs,
      ignoredAfterMs: 7 * 24 * 60 * 60 * 1000,
    };

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 0, { targetRepoFullName: "owner/old-merged", targetPullNumber: 60 }),
        pullRequests: [
          prRecord(60, "owner/old-merged", {
            state: "closed",
            mergedAt: "2026-04-01T00:00:00.000Z",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          }),
        ],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "stale", outcomeTargetType: "pull_request" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 1, { targetRepoFullName: "owner/old-issue", targetIssueNumber: 61 }),
        pullRequests: [],
        issues: [
          issueRecord(61, "owner/old-issue", {
            state: "closed",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          }),
        ],
      }),
    ).toMatchObject({ outcomeState: "stale", outcomeTargetType: "issue" });
  });

  it("uses timestamp fallbacks and deterministic earliest-match ordering for cached activity", () => {
    const run = runRecord("run-fallbacks", "Dev", "2026-05-01T00:00:00.000Z");
    const runWithoutUpdate = { ...run, updatedAt: undefined as unknown as string };
    const base = {
      evaluatedAt: "2026-06-01T00:00:00.000Z",
      staleAfterMs: 14 * 24 * 60 * 60 * 1000,
      ignoredAfterMs: 7 * 24 * 60 * 60 * 1000,
    };

    expect(
      classifyRecommendationOutcome({
        ...base,
        run,
        action: action(run, 0, { targetRepoFullName: "owner/run-updated", createdAt: undefined }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeRepoFullName: "owner/run-updated" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        run: runWithoutUpdate,
        action: action(runWithoutUpdate, 1, { targetRepoFullName: "owner/run-created", createdAt: undefined }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored", outcomeRepoFullName: "owner/run-created" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        run: { ...runWithoutUpdate, createdAt: undefined as unknown as string },
        action: action(runWithoutUpdate, 2, { createdAt: undefined }),
        pullRequests: [],
        issues: [],
      }),
    ).toBeNull();

    expect(
      classifyRecommendationOutcome({
        ...base,
        run,
        action: action(run, 3, { targetRepoFullName: "owner/pr-sort" }),
        pullRequests: [
          prRecord(72, "owner/pr-sort", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z", authorLogin: "dev" }),
          prRecord(71, "owner/pr-sort", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z", authorLogin: "DEV" }),
        ],
        issues: [],
      }),
    ).toMatchObject({ outcomePullNumber: 71, metadata: { matchedBy: "later_repo_pull_request" } });

    expect(
      classifyRecommendationOutcome({
        ...base,
        run,
        action: action(run, 4, { targetRepoFullName: "owner/issue-sort" }),
        pullRequests: [],
        issues: [
          issueRecord(82, "owner/issue-sort", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z", authorLogin: "dev" }),
          issueRecord(81, "owner/issue-sort", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z", authorLogin: "DEV" }),
        ],
      }),
    ).toMatchObject({ outcomeIssueNumber: 81, metadata: { matchedBy: "later_repo_issue" } });
  });

  it("classifies open fallback targets and maintainer associations without losing source timestamps", () => {
    const run = runRecord("run-open-fallbacks", "dev", "2026-05-01T00:00:00.000Z");
    const staleAfterMs = 14 * 24 * 60 * 60 * 1000;
    const base = {
      run,
      evaluatedAt: "2026-05-05T00:00:00.000Z",
      staleAfterMs,
      ignoredAfterMs: 1,
    };

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 0, { targetRepoFullName: "owner/pr-fallback", targetPullNumber: 90 }),
        pullRequests: [prRecord(90, "owner/pr-fallback", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z", mergeableState: "clean" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "improved", sourceUpdatedAt: "2026-05-03T00:00:00.000Z", metadata: { mergeableState: "clean" } });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 1, { targetRepoFullName: "owner/pr-created-fallback", targetPullNumber: 91 }),
        pullRequests: [prRecord(91, "owner/pr-created-fallback", { createdAt: "2026-05-03T00:00:00.000Z", updatedAt: undefined })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "accepted", sourceUpdatedAt: "2026-05-03T00:00:00.000Z" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 2, { targetRepoFullName: "owner/issue-fallback", targetIssueNumber: 92 }),
        pullRequests: [],
        issues: [issueRecord(92, "owner/issue-fallback", { createdAt: "2026-04-01T00:00:00.000Z", updatedAt: undefined })],
      }),
    ).toMatchObject({ outcomeState: "ignored", confidence: "medium", sourceUpdatedAt: "2026-04-01T00:00:00.000Z" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 3, { targetRepoFullName: "owner/issue-updated-fallback", targetIssueNumber: 93 }),
        pullRequests: [],
        issues: [issueRecord(93, "owner/issue-updated-fallback", { createdAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z" })],
      }),
    ).toMatchObject({ outcomeState: "accepted", sourceUpdatedAt: "2026-05-03T00:00:00.000Z" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 4, { targetRepoFullName: "owner/merged-state", targetPullNumber: 94 }),
        pullRequests: [prRecord(94, "owner/merged-state", { state: "merged", mergedAt: undefined, updatedAt: "2026-05-03T00:00:00.000Z" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "merged", sourceUpdatedAt: "2026-05-03T00:00:00.000Z" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 5, { targetRepoFullName: "owner/member", targetPullNumber: 95 }),
        pullRequests: [prRecord(95, "owner/member", { authorAssociation: "MEMBER" })],
        issues: [],
      }),
    ).toMatchObject({ maintainerLane: true });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 6, { targetRepoFullName: "owner/collab", targetIssueNumber: 96 }),
        pullRequests: [],
        issues: [issueRecord(96, "owner/collab", { authorAssociation: "COLLABORATOR" })],
      }),
    ).toMatchObject({ maintainerLane: true });
  });

  it("classifies rejected, and all seven outcome states are reachable from PR fixtures", () => {
    const run = runRecord("run-rejected", "dev", "2026-05-01T00:00:00.000Z");
    const base = {
      run,
      evaluatedAt: "2026-06-01T00:00:00.000Z",
      staleAfterMs: 14 * 24 * 60 * 60 * 1000,
      ignoredAfterMs: 7 * 24 * 60 * 60 * 1000,
    };

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 0, { targetRepoFullName: "owner/rejected-pr", targetPullNumber: 200 }),
        pullRequests: [prRecord(200, "owner/rejected-pr", { updatedAt: "2026-05-10T00:00:00.000Z", reviewDecision: "CHANGES_REQUESTED" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "rejected", outcomeTargetType: "pull_request", outcomePullNumber: 200, confidence: "high" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 1, { targetRepoFullName: "owner/merged-pr", targetPullNumber: 201 }),
        pullRequests: [prRecord(201, "owner/merged-pr", { state: "closed", mergedAt: "2026-05-05T00:00:00.000Z", updatedAt: "2026-05-05T00:00:00.000Z" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "merged" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 2, { targetRepoFullName: "owner/closed-pr", targetPullNumber: 202 }),
        pullRequests: [prRecord(202, "owner/closed-pr", { state: "closed", updatedAt: "2026-05-05T00:00:00.000Z" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "closed" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 3, { targetRepoFullName: "owner/improved-pr", targetPullNumber: 203 }),
        pullRequests: [prRecord(203, "owner/improved-pr", { updatedAt: "2026-05-05T00:00:00.000Z", reviewDecision: "APPROVED" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "improved" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 4, { targetRepoFullName: "owner/accepted-pr", targetPullNumber: 204 }),
        pullRequests: [prRecord(204, "owner/accepted-pr", { updatedAt: "2026-05-05T00:00:00.000Z" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "accepted" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 5, { targetRepoFullName: "owner/stale-pr", targetPullNumber: 205 }),
        pullRequests: [prRecord(205, "owner/stale-pr", { createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" })],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "stale" });

    expect(
      classifyRecommendationOutcome({
        ...base,
        action: action(run, 6, { targetRepoFullName: "owner/ignored-repo" }),
        pullRequests: [],
        issues: [],
      }),
    ).toMatchObject({ outcomeState: "ignored" });
  });

  it("captures surface and snapshotId on persisted outcome records", async () => {
    const env = createTestEnv();
    const run = runRecord("run-surface", "dev", "2026-05-01T00:00:00.000Z");
    await createAgentRun(env, run);
    const snap: AgentContextSnapshotRecord = {
      id: "snap-surface-001",
      runId: run.id,
      repoSignalSnapshotIds: [],
      freshnessWarnings: [],
      payload: {},
    };
    await persistAgentContextSnapshot(env, snap);
    await replaceAgentActions(env, run.id, [action(run, 0, { targetRepoFullName: "owner/surface-pr", targetPullNumber: 300 })]);
    await upsertPullRequestFromGitHub(env, "owner/surface-pr", pr(300, { state: "closed", merged_at: "2026-05-05T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-05T00:00:00.000Z" }));

    const result = await evaluateRecommendationOutcomes(env, "dev", { now: "2026-06-01T00:00:00.000Z" });
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0]!;
    expect(outcome.surface).toBe("api");
    expect(outcome.snapshotId).toBe("snap-surface-001");
    expect(outcome.outcomeState).toBe("merged");
  });

  it("does not expose private outcome fields in public-safe action summaries or serialized event JSON", async () => {
    const env = createTestEnv();
    const run = runRecord("run-privacy", "dev", "2026-05-01T00:00:00.000Z");
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [action(run, 0, { targetRepoFullName: "owner/private-pr", targetPullNumber: 400, publicSafeSummary: "Open a small scoped PR." })]);
    await upsertPullRequestFromGitHub(env, "owner/private-pr", pr(400, { state: "closed", merged_at: "2026-05-05T00:00:00.000Z", created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-05T00:00:00.000Z" }));

    const result = await evaluateRecommendationOutcomes(env, "dev", { now: "2026-06-01T00:00:00.000Z" });
    const outcome = result.outcomes[0]!;

    const privateSerialized = JSON.stringify(outcome);
    expect(privateSerialized).not.toMatch(/scoreabilit|reward|payout|wallet|hotkey|coldkey|raw trust/i);

    const summary = await getAgentRecommendationOutcomeSummary(env, "dev", { now: "2026-06-01T00:00:00.000Z" });
    expect(summary.privateSummary).not.toMatch(/scoreabilit|reward|payout|wallet|hotkey|coldkey|raw trust/i);
    expect(summary.totals.total).toBe(1);
    expect(summary.totals.merged).toBe(1);
    expect(summary.totals.rejected).toBe(0);
  });

  it("maps legacy recommendation outcome rows to safe enum defaults", async () => {
    const env = createTestEnv();
    const run = runRecord("legacy-run", "dev", "2026-05-01T00:00:00.000Z");
    const legacyAction = action(run, 0, { targetRepoFullName: "owner/legacy" });
    await createAgentRun(env, run);
    await replaceAgentActions(env, run.id, [legacyAction]);
    await upsertAgentRecommendationOutcome(env, {
      actionId: legacyAction.id,
      runId: run.id,
      actorLogin: "dev",
      actionType: "choose_next_work",
      targetRepoFullName: "owner/legacy",
      targetPullNumber: null,
      targetIssueNumber: null,
      outcomeState: "accepted",
      outcomeTargetType: "repository",
      outcomeRepoFullName: "owner/legacy",
      outcomePullNumber: null,
      outcomeIssueNumber: null,
      source: "inferred",
      maintainerLane: false,
      confidence: "high",
      reason: "legacy row fixture",
      detectedAt: "2026-05-01T00:00:00.000Z",
      metadata: {},
    });
    await env.DB.prepare(
      "update agent_recommendation_outcomes set action_type = ?, outcome_state = ?, outcome_target_type = ?, source = ?, confidence = ? where action_id = ?",
    )
      .bind("legacy_action", "legacy_state", "legacy_target", "legacy_source", "legacy_confidence", legacyAction.id)
      .run();

    const [row] = await listAgentRecommendationOutcomes(env, { actorLogin: "dev" });
    expect(row).toMatchObject({
      actionType: "choose_next_work",
      outcomeState: "ignored",
      outcomeTargetType: "none",
      source: "inferred",
      confidence: "medium",
    });
  });
});

function runRecord(id: string, actorLogin: string, createdAt: string): AgentRunRecord {
  return {
    id,
    objective: "Plan the next Gittensor OSS contribution action.",
    actorLogin,
    surface: "api",
    mode: "copilot",
    status: "completed",
    dataQualityStatus: "complete",
    payload: { kind: "plan_next_work", login: actorLogin },
    createdAt,
    updatedAt: createdAt,
  };
}

function action(run: AgentRunRecord, index: number, overrides: Partial<AgentActionRecord> = {}): AgentActionRecord {
  return {
    id: `${run.id}:${String(index).padStart(2, "0")}:choose_next_work`,
    runId: run.id,
    actionType: "choose_next_work",
    targetRepoFullName: "owner/repo",
    status: "recommended",
    recommendation: "Pick narrow work and validate it.",
    why: ["The repo has cached opportunity signals."],
    blockedBy: [],
    publicSafeSummary: "Use local branch preflight before posting.",
    approvalRequired: true,
    safetyClass: "private",
    payload: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function answer(
  id: string,
  command: string,
  repoFullName: string,
  issueNumber: number,
  metadata: Record<string, string | number | boolean | null> = {},
): Parameters<typeof upsertAgentCommandAnswer>[1] {
  return {
    id,
    repoFullName,
    issueNumber,
    command,
    requestCommentId: 1,
    responseCommentId: 2,
    responseUrl: null,
    actorKind: "maintainer",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    metadata,
  };
}

function pr(number: number, overrides: Partial<GitHubPullRequestPayload> = {}): GitHubPullRequestPayload {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    user: { login: "dev" },
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/owner/repo/pull/${number}`,
    body: "",
    labels: [],
    head: { sha: `sha-${number}`, ref: `branch-${number}` },
    base: { ref: "main" },
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  } as GitHubPullRequestPayload;
}

function prRecord(number: number, repoFullName: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "CONTRIBUTOR",
    htmlUrl: `https://github.com/${repoFullName}/pull/${number}`,
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

function issue(number: number, overrides: Partial<GitHubIssuePayload> = {}): GitHubIssuePayload {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    user: { login: "dev" },
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/owner/repo/issues/${number}`,
    body: "",
    labels: [],
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  } as GitHubIssuePayload;
}

function issueRecord(number: number, repoFullName: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title: `Issue ${number}`,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "CONTRIBUTOR",
    htmlUrl: `https://github.com/${repoFullName}/issues/${number}`,
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    labels: [],
    linkedPrs: [],
    ...overrides,
  };
}
