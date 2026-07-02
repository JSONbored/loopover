import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
  dismissLatestBotApproval: vi.fn(async () => ({ dismissed: true })),
}));
vi.mock("../../src/github/labels", () => ({
  ensurePullRequestLabel: vi.fn(async () => ({ applied: true, created: false })),
}));
vi.mock("../../src/github/pr-freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/pr-freshness")>();
  return {
    ...actual,
    fetchPullRequestFreshness: vi.fn(async (_env: Env, args: { expectedHeadSha?: string | null }) => ({
      status: "current" as const,
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
    })),
  };
});
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(async () => "test-installation-token"),
}));
// The accept-time live re-check (#2126) AND the actuation-time live CI re-check (#2128) both default to
// "everything still looks fine" so the existing accept tests stay deterministic; individual tests below
// override these to exercise the staleness-supersede / staleness-denial paths.
vi.mock("../../src/github/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/backfill")>()),
  fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null })),
  fetchLivePullRequestMergeState: vi.fn(async () => "clean"),
  fetchLivePullRequestReviewDecision: vi.fn(async () => undefined),
}));
// resolveLinkedIssueHardRule defaults to the REAL implementation, which is a safe no-op here: loadLinkedIssueHardRules
// (also real, unmocked) always returns the all-off default config, so the real resolver returns undefined (not
// violated) without any GitHub fetch. Individual tests override it to exercise the accept-time recheck (#2132).
vi.mock("../../src/review/linked-issue-hard-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/review/linked-issue-hard-rules")>();
  return {
    ...actual,
    resolveLinkedIssueHardRule: vi.fn(actual.resolveLinkedIssueHardRule),
  };
});

import { createPullRequestReview, mergePullRequest } from "../../src/github/pr-actions";
import { ensurePullRequestLabel } from "../../src/github/labels";
import { createInstallationToken } from "../../src/github/app";
import { fetchLiveCiAggregate, fetchLivePullRequestMergeState, fetchLivePullRequestReviewDecision } from "../../src/github/backfill";
import { resolveLinkedIssueHardRule } from "../../src/review/linked-issue-hard-rules";
import { actionParams, executeAgentMaintenanceActions, pendingActionToPlanned, type AgentActionExecutionContext } from "../../src/services/agent-action-executor";
import { decidePendingAgentAction } from "../../src/services/agent-approval-queue";
import {
  countPendingAgentActions,
  createPendingAgentActionIfAbsent,
  getPendingAgentAction,
  listNotificationDeliveriesForRecipient,
  listPendingAgentActions,
  setPendingAgentActionStatus,
  upsertInstallation,
  upsertPullRequestFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
import { createTestEnv } from "../helpers/d1";

function ctx(over: Partial<AgentActionExecutionContext> = {}): AgentActionExecutionContext {
  return {
    installationId: 5,
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "h7",
    autonomy: { merge: "auto_with_approval" },
    agentPaused: false,
    agentDryRun: false,
    installationPermissions: { pull_requests: "write", issues: "write" },
    ...over,
  };
}

const mergeApproval: PlannedAgentAction = { actionClass: "merge", requiresApproval: true, reason: "clean + 1 approval", mergeMethod: "squash" };

async function seedInstallation(env: Env): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: 5,
      account: { login: "owner", id: 1, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "write", issues: "write" },
      events: ["pull_request"],
    },
    repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
  });
}

describe("agent approval queue (#779)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("staging: an auto_with_approval action is queued — pending row + maintainer notification, no GitHub call", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [mergeApproval]);
    expect(outcomes[0]?.outcome).toBe("queued");
    expect(mergePullRequest).not.toHaveBeenCalled();

    const pending = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionClass: "merge", status: "pending", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" } });

    const deliveries = await listNotificationDeliveriesForRecipient(env, "owner");
    expect(deliveries.some((d) => d.eventType === "agent.pending_action" && d.pullNumber === 7)).toBe(true);

    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.merge").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("queued");
  });

  it("staging is idempotent: a second evaluation does not duplicate the row or re-notify", async () => {
    const env = createTestEnv({});
    await executeAgentMaintenanceActions(env, ctx(), [mergeApproval]);
    await executeAgentMaintenanceActions(env, ctx(), [mergeApproval]);
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(1);
    const deliveries = (await listNotificationDeliveriesForRecipient(env, "owner")).filter((d) => d.eventType === "agent.pending_action");
    expect(deliveries).toHaveLength(1);
  });

  it("createPendingAgentActionIfAbsent reports created vs already-staged", async () => {
    const env = createTestEnv({});
    const input = { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge" as const, autonomyLevel: "auto_with_approval" as const, params: { mergeMethod: "squash" as const }, reason: "x" };
    expect((await createPendingAgentActionIfAbsent(env, input)).created).toBe(true);
    const second = await createPendingAgentActionIfAbsent(env, input);
    expect(second.created).toBe(false);
    expect(second.action.status).toBe("pending");
  });

  it("accept: executes the staged action live, marks it accepted, and audits completed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("accepted");
    const audit = await env.DB.prepare("select outcome, actor from audit_events where event_type = ?").bind("agent.pending_action.accepted").first<{ outcome: string; actor: string }>();
    expect(audit).toMatchObject({ outcome: "completed", actor: "owner" });
  });

  it("accept supersedes a staged merge when the live head moved after staging (force-push fail-safe)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    // The PR head is now h-NEW: the contributor force-pushed after the merge was staged against h-OLD.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-NEW" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h-OLD" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("head_moved");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("force-push after staging");
  });

  it("accept executes a staged merge when the staged head still matches the live head (pinned to the reviewed SHA)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    // Pinned to the REVIEWED head from the staged params — not merely whatever the current head happens to be.
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("REGRESSION (#2422): accept denies a merge staged with NO reviewed-head pin, rather than silently merging whatever commit is currently live", async () => {
    // Unlike a PINNED merge, where GitHub's `sha` param 409s on mismatch (a real backstop), an UNPINNED merge
    // falls back to performAction's `mergeSha = action.expectedHeadSha ?? ctx.headSha`, which by construction
    // substitutes the current live head -- no mismatch is possible, so the 409 backstop never fires. This is the
    // same class of gap #2377 closed for approve; the identical accept-flow gate now covers merge too.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-UNREVIEWED" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("unpinned_legacy_action");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("no reviewed-head pin");
  });

  it("accept executes a staged approve when the staged head still matches the live head, pinned to the reviewed SHA (#2262)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { approve: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "approve", autonomyLevel: "auto_with_approval", params: { reviewBody: "lgtm", expectedHeadSha: "h7" }, reason: "gate passed" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    // Pinned to the REVIEWED head via commit_id — not merely whatever the current head happens to be.
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 5, "owner/repo", 7, "APPROVE", "lgtm", "h7");
  });

  it("REGRESSION (#2377): accept denies an approve staged with NO reviewed-head pin, rather than silently approving whatever commit is currently live", async () => {
    // A row with no expectedHeadSha (e.g. staged by code predating the head-pin fix, or a planning pass that ran
    // against a transiently-null stored head SHA) carries no record of what was actually reviewed. Unlike merge's
    // `sha` param, GitHub's review API has no server-side staleness rejection for `commit_id` — the ONLY
    // protection is this application-level check, so an unpinned row must be refused, not silently approved
    // against whatever the live head happens to be at accept time.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { approve: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-UNREVIEWED" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "approve", autonomyLevel: "auto_with_approval", params: { reviewBody: "lgtm" }, reason: "gate passed" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("unpinned_legacy_action");
    expect(createPullRequestReview).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("no reviewed-head pin");
  });

  it("REGRESSION (#2452): accept denies a close staged with NO reviewed-head pin, rather than silently comparing the live head to itself", async () => {
    // Unlike merge's `sha` param or approve's `commit_id`, close has NO server-side commit target at all -- the
    // executor's step-5 freshness guard falls back to `action.expectedHeadSha ?? ctx.headSha`, and ctx.headSha is
    // fetched fresh from the SAME DB row this function just re-read, so an unpinned close's freshness check
    // trivially compares the live head against itself and can never catch a force-push after staging.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { close: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-UNREVIEWED" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "close", autonomyLevel: "auto_with_approval", params: { closeComment: "noise", closeKind: "heuristic" }, reason: "ci-failed" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("unpinned_legacy_action");
    const { closePullRequest: closeUnpinned } = await import("../../src/github/pr-actions");
    expect(closeUnpinned).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
  });

  it("accept supersedes a staged close when the live head moved after staging (force-push fail-safe, #2452)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { close: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-NEW" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "close", autonomyLevel: "auto_with_approval", params: { closeComment: "noise", closeKind: "heuristic", expectedHeadSha: "h-OLD" }, reason: "ci-failed" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("head_moved");
    const { closePullRequest: closeMoved } = await import("../../src/github/pr-actions");
    expect(closeMoved).not.toHaveBeenCalled();
  });

  it("accept executes a staged blacklist close when the contributor is STILL blacklisted at accept time (#2452)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, {
      repoFullName: "owner/repo",
      autonomy: { close: "auto_with_approval" },
      contributorBlacklist: [{ login: "plagiarist", reason: "plagiarism" }],
    });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "plagiarist" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "close", autonomyLevel: "auto_with_approval", params: { closeComment: "blocked", closeKind: "blacklist", expectedHeadSha: "h7" }, reason: "blacklisted contributor" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    const { closePullRequest: closeStillBlacklisted } = await import("../../src/github/pr-actions");
    expect(closeStillBlacklisted).toHaveBeenCalledWith(env, 5, "owner/repo", 7);
  });

  it("REGRESSION (#2452): accept supersedes a staged blacklist close when the contributor is NO LONGER blacklisted at accept time", async () => {
    // The head-SHA pin alone cannot catch this: the contributor never force-pushed, so the freshness check above
    // passes cleanly -- only re-resolving blacklist membership against the CURRENT repo settings (not the
    // plan-time snapshot baked into the sticky pending row) detects that the maintainer removed the entry.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { close: "auto_with_approval" }, contributorBlacklist: [] });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "reformed" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "close", autonomyLevel: "auto_with_approval", params: { closeComment: "blocked", closeKind: "blacklist", expectedHeadSha: "h7" }, reason: "blacklisted contributor" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("no_longer_blacklisted");
    const { closePullRequest: closeNoLonger } = await import("../../src/github/pr-actions");
    expect(closeNoLonger).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("no longer on the blacklist");
  });

  it("accept does NOT deny an unpinned dismissStaleApproval retraction — retracting an approval carries no ratify-unreviewed-code risk (#2377)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { approve: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-CURRENT" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "approve", autonomyLevel: "auto_with_approval", params: { dismissStaleApproval: true }, reason: "stale approval retracted" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(createPullRequestReview).not.toHaveBeenCalled(); // dismiss retracts, never posts a new APPROVE
  });

  it("accept supersedes a staged approve when the live head moved after staging (force-push fail-safe, #2262)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { approve: "auto_with_approval" } });
    await seedInstallation(env);
    // The PR head is now h-NEW: the contributor force-pushed after the approve was staged against h-OLD. Before
    // #2262, expectedHeadSha was never set on a planned approve, so this staleness guard was a silent no-op and
    // the accept would have approved the new, unreviewed commit.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-NEW" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "approve", autonomyLevel: "auto_with_approval", params: { reviewBody: "lgtm", expectedHeadSha: "h-OLD" }, reason: "gate passed" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("head_moved");
    expect(createPullRequestReview).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("force-push after staging");
  });

  it("accept supersedes a staged merge when live CI has since turned failed (no head move) (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    // Also exercise a best-effort-failed mergeable/review read (undefined) alongside the CI failure — the
    // audit metadata's nullish fallback must not throw, and ciState alone is still sufficient to deny.
    vi.mocked(fetchLivePullRequestMergeState).mockResolvedValueOnce(undefined);

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("live CI is no longer passing (now: failed)");
  });

  it("accept supersedes a staged merge when live CI has since turned pending, not just failed (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    // A FULFILLED "pending" read is a genuine non-passing signal — distinct from a REJECTED read (fail-open,
    // covered by the "ITSELF rejects" test below), which must NOT supersede.
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "pending", hasPending: true, hasVisiblePending: true, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("live CI is no longer passing (now: pending)");
  });

  it("accept supersedes a staged merge when the base now conflicts (mergeable_state: dirty) (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLivePullRequestMergeState).mockResolvedValueOnce("dirty");

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("accept supersedes a staged merge when a reviewer has since requested changes (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLivePullRequestReviewDecision).mockResolvedValueOnce("CHANGES_REQUESTED");

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("accept re-syncs the merge method to the CURRENT repo config, not the staging-time snapshot (#2131)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    // Staged while the default was "squash"; the maintainer has since changed the repo's default to "merge".
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" }, autoMaintain: { mergeMethod: "merge", requireApprovals: 0 } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "merge", sha: "h7" });
  });

  it("accept downgrades a staged merge to a needs-human-review label when the precision breaker engaged after staging (#2127)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval", label: "auto" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    // The merge-precision breaker engages fleet-wide AFTER this merge was staged.
    await env.DB.prepare("INSERT INTO system_flags (key, value) VALUES (?, ?)").bind("holdonly:owner/repo", "true").run();

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 5, "owner/repo", 7, "gittensory:needs-human-review", { createMissingLabel: true });
  });

  it("REGRESSION: a precision-breaker-downgraded merge still executes the hold/label plan even when the linked issue would now violate the hard rule", async () => {
    // Before the fix, the linked-issue recheck gated on pending.actionClass (the ORIGINAL staged class), not the
    // post-downgrade plan -- so a merge already downgraded to a needs-human-review label by the #2127 precision
    // breaker above would still get its whole row rejected on a stale linked-issue violation, silently swallowing
    // the hold label the breaker was supposed to guarantee.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval", label: "auto" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: true, reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs." });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    // The merge-precision breaker engages fleet-wide AFTER this merge was staged — same as the #2127 test above.
    await env.DB.prepare("INSERT INTO system_flags (key, value) VALUES (?, ?)").bind("holdonly:owner/repo", "true").run();

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 5, "owner/repo", 7, "gittensory:needs-human-review", { createMissingLabel: true });
    // The recheck must not even run once the plan no longer contains a merge -- there's nothing left to validate.
    expect(resolveLinkedIssueHardRule).not.toHaveBeenCalled();
  });

  it("accept executes a staged merge normally when the precision breaker is off", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("accept still executes when the live re-check's token mint fails — fails OPEN on that specific check (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(createInstallationToken).mockRejectedValueOnce(new Error("installation suspended"));

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    // The live-recheck's own token mint failing does not block the accept — the executor mints its own token
    // for the actual mutation independently, so a transient failure here fails open on THIS check specifically.
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("accept still executes when a live re-check ITSELF rejects — fails OPEN on that specific check, not the whole accept (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    // A bare Promise.all over the three live re-checks would throw the whole accept out on this single
    // rejection; Promise.allSettled must isolate it to just the CI check.
    vi.mocked(fetchLiveCiAggregate).mockRejectedValueOnce(new Error("GitHub API transient 502"));

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("accept still supersedes on a genuine mergeable-state hit when a SIBLING live re-check rejects (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLivePullRequestReviewDecision).mockRejectedValueOnce(new Error("GitHub API transient 502"));
    vi.mocked(fetchLivePullRequestMergeState).mockResolvedValueOnce("dirty");

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ detail: string }>();
    expect(audit?.detail).toContain("mergeable_state: dirty");
  });

  it("accept still supersedes on a genuine mergeable-state hit when the CI live re-check ITSELF rejects — audits a null ciState, not the rejection's own value (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLiveCiAggregate).mockRejectedValueOnce(new Error("GitHub API transient 502"));
    vi.mocked(fetchLivePullRequestMergeState).mockResolvedValueOnce("dirty");

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
    const audit = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ detail: string; metadata_json: string }>();
    expect(audit?.detail).toContain("mergeable_state: dirty");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ ciState: null });
  });

  it("accept still supersedes on a genuine CI-failed hit when the mergeable-state live re-check rejects (#2126)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(fetchLivePullRequestMergeState).mockRejectedValueOnce(new Error("GitHub API transient 502"));
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("stale_disposition");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("accept downgrades a staged heuristic close to a needs-human-review label when the close breaker engaged (#2127)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { close: "auto_with_approval", label: "auto" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 8, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h8" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 8, installationId: 5, actionClass: "close", autonomyLevel: "auto_with_approval", params: { closeComment: "noise", closeKind: "heuristic", expectedHeadSha: "h8" }, reason: "ci-failed" });
    await env.DB.prepare("INSERT INTO system_flags (key, value) VALUES (?, ?)").bind("closehold:owner/repo", "true").run();

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    const { closePullRequest } = await import("../../src/github/pr-actions");
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 5, "owner/repo", 8, "gittensory:needs-human-review", { createMissingLabel: true });
  });

  it("accept supersedes a staged merge when the linked issue trips a hard rule after staging (#2132)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    // Staged against a CONTRIBUTOR PR whose linked issue was eligible at plan time; between staging and accept
    // another maintainer relabeled the linked issue (head SHA unchanged, so the freshness check above misses it).
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: true, reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs." });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("linked_issue_hard_rule");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("maintainer-only");
  });

  it("accept executes a staged merge when the linked issue remains eligible", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: false, reason: null });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("accept still executes when the linked-issue recheck's own token mint fails — fails OPEN, ciToken passed as undefined (#2132)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: false, reason: null });
    // First call is the #2126 merge-live-recheck's own token mint (succeeds); the second is this new linked-issue
    // recheck's token mint, which fails here. The executor mints its own token for the actual mutation
    // independently, so this transient failure must fail open on THIS check specifically, not block the accept.
    vi.mocked(createInstallationToken).mockResolvedValueOnce("test-installation-token").mockRejectedValueOnce(new Error("installation suspended"));
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
    expect(vi.mocked(resolveLinkedIssueHardRule)).toHaveBeenCalledWith(expect.objectContaining({ ciToken: undefined }));
  });

  it("accept supersedes with a fallback reason when the hard-rule result omits one", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: true, reason: null });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("linked_issue_hard_rule");
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ detail: string }>();
    expect(audit?.detail).toContain("ineligible linked issue");
  });

  it("accept tolerates a slash-less repoFullName and a missing PR author login (defensive fallbacks)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "solorepo", autonomy: { merge: "auto_with_approval" } });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "solorepo", full_name: "solorepo", private: false, owner: { login: "owner" } }],
    });
    // No `user` on the payload → authorLogin stored null; repoFullName has no "/" → repoOwner falls back to "".
    await upsertPullRequestFromGitHub(env, "solorepo", { number: 7, title: "PR", state: "open", head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "solorepo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "solorepo", 7, { mergeMethod: "squash", sha: "h7" });
  });

  it("accept does not consult the linked-issue hard rule for an owner-authored staged merge (mirrors the planner's closeEligible exemption)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    // Author IS the repo owner ("owner/repo" → owner login "owner"); closeOwnerAuthors defaults false, so the
    // hard rule must never even be consulted for this PR, regardless of what it would say.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "owner" }, head: { sha: "h7" }, labels: [], body: "Closes #9" });
    vi.mocked(resolveLinkedIssueHardRule).mockResolvedValueOnce({ violated: true, reason: "would have violated, but must not even be checked" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 5, "owner/repo", 7, { mergeMethod: "squash", sha: "h7" });
    expect(resolveLinkedIssueHardRule).not.toHaveBeenCalled();
  });

  it("accept does not supersede when the PR record is absent (no live head to compare) — proceeds to the executor", async () => {
    const env = createTestEnv({});
    // No PR seeded → getPullRequest returns null → pr?.headSha is undefined, so the staleness guard is skipped
    // even though the staged action carries an expectedHeadSha. No settings/install → the merge denies downstream.
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h-OLD" }, reason: "clean" });
    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("denied");
    expect(mergePullRequest).not.toHaveBeenCalled();
    const superseded = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.pending_action.superseded").first<{ n: number }>();
    expect(superseded?.n).toBe(0);
  });

  it("accept honors current dry-run setting instead of forcing a live mutation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" }, agentDryRun: true });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("dry_run");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("accept denies stale pending actions when current autonomy no longer acts for that class", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { approve: "auto" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted");
    expect(result.executionOutcome).toBe("denied");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("reject: cancels without executing, marks it rejected, and audits", async () => {
    const env = createTestEnv({});
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });
    const result = await decidePendingAgentAction(env, { id: action.id, decision: "reject", decidedBy: "owner" });
    expect(result.status).toBe("rejected");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
    expect((await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.pending_action.rejected").first<{ outcome: string }>())?.outcome).toBe("completed");
  });

  it("a second decision on a decided action is a no-op", async () => {
    const env = createTestEnv({});
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    await decidePendingAgentAction(env, { id: action.id, decision: "reject", decidedBy: "owner" });
    const second = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(second.status).toBe("already_decided");
    expect(second.action?.status).toBe("rejected");
  });

  it("returns not_found for an unknown id", async () => {
    const env = createTestEnv({});
    expect((await decidePendingAgentAction(env, { id: "nope", decision: "accept", decidedBy: "owner" })).status).toBe("not_found");
  });

  it("accept records error when the staged action cannot execute (no write permission)", async () => {
    const env = createTestEnv({});
    // No settings/installation seeded → autonomy is empty + no pull_requests:write → the merge is denied.
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted"); // the decision is recorded...
    expect(result.executionOutcome).toBe("denied"); // ...but the action could not run
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.pending_action.accepted").first<{ outcome: string }>())?.outcome).toBe("error");
  });

  it("REGRESSION (#2423): accept persists status=errored, not accepted, when the executor's mutation call throws", async () => {
    // Distinct from the "no write permission" test above: there, the executor's own gates cleanly DENY before
    // ever attempting a mutation -- a legitimate, intentional non-action, correctly recorded as "accepted". Here
    // every gate passes and the executor genuinely ATTEMPTS the GitHub call, which fails -- that failure must not
    // read the same as a quiet, uneventful success in the approval-queue listing.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await seedInstallation(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(mergePullRequest).mockRejectedValueOnce(new Error("GitHub 500"));

    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("errored");
    expect(result.executionOutcome).toBe("error");
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("errored");
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.pending_action.accepted").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("error");
  });

  it("actionParams extracts only the field for the action class", () => {
    expect(actionParams({ actionClass: "label", requiresApproval: false, reason: "x", label: "L" })).toEqual({ label: "L" });
    expect(actionParams({ actionClass: "request_changes", requiresApproval: false, reason: "x", reviewBody: "B" })).toEqual({ reviewBody: "B" });
    expect(actionParams({ actionClass: "merge", requiresApproval: false, reason: "x", mergeMethod: "rebase" })).toEqual({ mergeMethod: "rebase" });
    expect(actionParams({ actionClass: "close", requiresApproval: false, reason: "x", closeComment: "C" })).toEqual({ closeComment: "C" });
    // closeKind must round-trip through staging — without it the close-precision breaker could never match a
    // staged close as heuristic on accept (#2127).
    expect(actionParams({ actionClass: "close", requiresApproval: false, reason: "x", closeComment: "C", closeKind: "heuristic" })).toEqual({ closeComment: "C", closeKind: "heuristic" });
  });

  it("lists all pending actions unfiltered and stores a null reason when omitted", async () => {
    const env = createTestEnv({});
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 9, installationId: 5, actionClass: "label", autonomyLevel: "auto_with_approval", params: { label: "L" } });
    expect(action.reason).toBeNull();
    expect(await listPendingAgentActions(env, {})).toHaveLength(1);
  });

  it("pendingActionToPlanned clears requiresApproval and defaults the reason", () => {
    expect(pendingActionToPlanned({ actionClass: "merge", params: { mergeMethod: "squash" } })).toMatchObject({ actionClass: "merge", requiresApproval: false, reason: "maintainer-approved", mergeMethod: "squash" });
    expect(pendingActionToPlanned({ actionClass: "label", params: { label: "L" }, reason: "explicit" }).reason).toBe("explicit");
  });

  it("countPendingAgentActions respects both the repo filter and the status filter", async () => {
    const env = createTestEnv({});
    // owner/repo: 3 pending rows (PRs 1-3) + 1 that we decide as rejected (PR 4).
    for (let pullNumber = 1; pullNumber <= 4; pullNumber += 1) {
      await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    }
    const { action: rejected } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 5, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    await setPendingAgentActionStatus(env, rejected.id, { status: "rejected", decidedBy: "owner" });
    // other/repo: 2 pending rows (PRs 1-2) — must be excluded by the repo filter.
    for (let pullNumber = 1; pullNumber <= 2; pullNumber += 1) {
      await createPendingAgentActionIfAbsent(env, { repoFullName: "other/repo", pullNumber, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    }

    // No filter: counts every row across both repos and all statuses (4 + 1 rejected + 2 = 7).
    expect(await countPendingAgentActions(env, {})).toBe(7);
    // Repo filter only: every owner/repo row regardless of status (4 pending + 1 rejected).
    expect(await countPendingAgentActions(env, { repoFullName: "owner/repo" })).toBe(5);
    // Status filter only: every pending row across both repos (4 + 2).
    expect(await countPendingAgentActions(env, { status: "pending" })).toBe(6);
    // Both filters: only owner/repo's pending rows, excluding the rejected one and other/repo.
    expect(await countPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" })).toBe(4);
    // Sanity: a repo with no rows counts zero.
    expect(await countPendingAgentActions(env, { repoFullName: "nobody/repo", status: "pending" })).toBe(0);
  });

  it("countPendingAgentActions counts the full set beyond the 200-row list page size", async () => {
    const env = createTestEnv({});
    for (let pullNumber = 1; pullNumber <= 201; pullNumber += 1) {
      await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    }
    // listPendingAgentActions caps at 200 by default; the count query is not page-limited.
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" })).toHaveLength(200);
    expect(await countPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" })).toBe(201);
  });
});
