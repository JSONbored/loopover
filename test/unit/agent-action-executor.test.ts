import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  closeIssue: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
  updatePullRequestBranch: vi.fn(async () => undefined),
  dismissLatestBotApproval: vi.fn(async () => ({ dismissed: true })),
}));
vi.mock("../../src/github/labels", () => ({
  ensurePullRequestLabel: vi.fn(async () => ({ applied: true, created: false })),
  removePullRequestLabel: vi.fn(async () => undefined),
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
// The actuation-time live CI re-check (#2128) defaults to "still passing" so the existing merge tests stay
// deterministic; individual tests below override this to exercise the staleness-denial path.
vi.mock("../../src/github/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/backfill")>()),
  fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null })),
  refreshInstallationHealthForInstallation: vi.fn(async () => null),
}));

import { closeIssue, closePullRequest, createIssueComment, createPullRequestReview, dismissLatestBotApproval, mergePullRequest, updatePullRequestBranch } from "../../src/github/pr-actions";
import { ensurePullRequestLabel, removePullRequestLabel } from "../../src/github/labels";
import { fetchPullRequestFreshness } from "../../src/github/pr-freshness";
import { createInstallationToken } from "../../src/github/app";
import { fetchLiveCiAggregate, refreshInstallationHealthForInstallation } from "../../src/github/backfill";
import {
  actionParams,
  clearInstallationHealthRefreshCooldownForTest,
  clearWritePermissionDenialCooldownForTest,
  executeAgentMaintenanceActions,
  executeIssueMaintenanceActions,
  pendingActionToPlanned,
  pendingClosureLabelApplied,
  type AgentActionExecutionContext,
  type AgentActionOutcome,
  type IssueActionExecutionContext,
} from "../../src/services/agent-action-executor";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
import { AGENT_LABEL_PENDING_CLOSURE } from "../../src/review/linked-issue-hard-rules";
import { getGlobalContributorBlacklist, isGlobalAgentFrozen, setGlobalAgentFrozen, upsertGlobalModerationConfig, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";
import { MODERATION_VIOLATION_EVENT_TYPE } from "../../src/settings/moderation-rules";

function ctx(over: Partial<AgentActionExecutionContext> = {}): AgentActionExecutionContext {
  return {
    installationId: 123,
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "sha7",
    autonomy: { label: "auto", request_changes: "auto", approve: "auto", merge: "auto", close: "auto", update_branch: "auto" },
    agentPaused: false,
    agentDryRun: false,
    installationPermissions: { pull_requests: "write", contents: "write", issues: "write" },
    ...over,
  };
}

const label: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "ready", label: "gittensory:ready-to-merge" };
const requestChanges: PlannedAgentAction = { actionClass: "request_changes", requiresApproval: false, reason: "1 blocker", reviewBody: "please fix" };
const approve: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "passed", reviewBody: "lgtm" };
const merge: PlannedAgentAction = { actionClass: "merge", requiresApproval: false, reason: "clean", mergeMethod: "squash" };
const close: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "noise", closeComment: "closing" };
const updateBranch: PlannedAgentAction = { actionClass: "update_branch", requiresApproval: false, reason: "behind", expectedHeadSha: "sha7" };

async function auditFor(env: Env, actionClass: string): Promise<{ outcome: string; metadata_json: string } | null> {
  return env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ? order by created_at desc limit 1").bind(`agent.action.${actionClass}`).first();
}

describe("executeAgentMaintenanceActions (#778 gate stack)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPullRequestFreshness).mockImplementation(async (_env, args) => ({
      status: "current",
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
    }));
    clearInstallationHealthRefreshCooldownForTest();
    clearWritePermissionDenialCooldownForTest();
    resetMetrics();
  });

  it("actionParams threads expectedHeadSha for an update_branch action (and omits absent fields)", () => {
    expect(actionParams(updateBranch)).toEqual({ expectedHeadSha: "sha7" });
    expect(actionParams(label)).toEqual({ label: "gittensory:ready-to-merge" });
    expect(actionParams(merge)).toEqual({ mergeMethod: "squash" });
  });

  it("LIVE: executes each action class via its GitHub primitive and audits completed", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [label, requestChanges, approve, merge, close, updateBranch]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["completed", "completed", "completed", "completed", "completed", "completed"]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "gittensory:ready-to-merge", { createMissingLabel: true });
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "REQUEST_CHANGES", "please fix");
    // Falls back to ctx.headSha ("sha7") as the pinned commit_id when the action carries no expectedHeadSha of
    // its own — a live sweep's approve plans no explicit pin, so this is the unpinned/live-sweep case (#2262).
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "lgtm", "sha7");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7, { mergeMethod: "squash", sha: "sha7" });
    expect(createIssueComment).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "closing");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
    expect(updatePullRequestBranch).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "sha7");
    expect(fetchPullRequestFreshness).toHaveBeenCalledTimes(6);
    expect((await auditFor(env, "merge"))?.outcome).toBe("completed");
  });

  it("#label-scoping: a label action's autonomyClass (not the literal actionClass) governs the durable re-check", async () => {
    const env = createTestEnv({});
    // autonomy.label is OFF; autonomy.close is ON — a label authorized via autonomyClass: "close" must still
    // execute, proving the executor resolves autonomy via `autonomyClass ?? actionClass`, not `actionClass` alone.
    const enforcementLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "blacklisted contributor", label: "slop", labelOp: "add" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ autonomy: { label: "observe", close: "auto" } }), [enforcementLabel]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "slop", { createMissingLabel: true });
  });

  it("#label-scoping: a label action with autonomyClass: close is DENIED when close is not acting, even if the generic label class is on", async () => {
    const env = createTestEnv({});
    const enforcementLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "blacklisted contributor", label: "slop", labelOp: "add" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ autonomy: { label: "auto", close: "observe" } }), [enforcementLabel]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2424): LIVE update_branch falls back to ctx.headSha when the action carries no expectedHeadSha of its own", async () => {
    // The `updateBranch` fixture above is pre-pinned (expectedHeadSha: "sha7"), so the big LIVE test never
    // exercises the `?? ctx.headSha` fallback -- it's parity with approve/merge for the tiny window between
    // step 5's freshness read and this call, matching a live sweep's construction (processors.ts:2196-2202
    // always sets expectedHeadSha, but the fallback exists for any future/legacy caller that omits it).
    const env = createTestEnv({});
    const unpinnedUpdateBranch: PlannedAgentAction = { actionClass: "update_branch", requiresApproval: false, reason: "behind base" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ headSha: "sha7" }), [unpinnedUpdateBranch]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(updatePullRequestBranch).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "sha7");
  });

  it("LIVE approve with dismissStaleApproval retracts the stale review instead of posting a new one (#2254)", async () => {
    const env = createTestEnv({});
    const dismiss: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "stale approval retracted", dismissStaleApproval: true };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [dismiss]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(dismissLatestBotApproval).toHaveBeenCalledWith(env, 123, "owner/repo", 7, expect.any(String));
    expect(createPullRequestReview).not.toHaveBeenCalled();
  });

  it("actionParams threads dismissStaleApproval for a stale-approval retraction action", () => {
    const dismiss: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "stale", dismissStaleApproval: true };
    expect(actionParams(dismiss)).toEqual({ dismissStaleApproval: true });
  });

  it("REGRESSION (#2361): retracting a stale approval does NOT stamp the current (unqualified) head as approved", async () => {
    const env = createTestEnv({});
    // approvedHeadSha starts at the OLD (actually-reviewed) commit; ctx().headSha ("sha7") is the NEWER,
    // no-longer-qualifying commit this dismissal is reacting to.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "c" }, head: { sha: "sha7" }, labels: [], body: "" });
    const dismiss: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "stale approval retracted", dismissStaleApproval: true };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [dismiss]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(dismissLatestBotApproval).toHaveBeenCalled();
    const row = await env.DB.prepare("select approved_head_sha as approvedHeadSha from pull_requests where repo_full_name = ? and number = ?")
      .bind("owner/repo", 7)
      .first<{ approvedHeadSha: string | null }>();
    // A real approve would have set this to "sha7" (see the "LIVE: executes each action class" test above for
    // that positive case) -- a dismissal must never mark the un-reviewed head as approved.
    expect(row?.approvedHeadSha).not.toBe("sha7");
  });

  it("REGRESSION (#2361): a queued stale-approval dismissal pinned to an evaluated head is denied when the live head has since moved again", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "evaluated-sha",
      liveHeadSha: "sha7",
      liveState: "open",
    });
    // ctx().headSha ("sha7") is the CURRENT live head at accept/replay time; expectedHeadSha ("evaluated-sha")
    // is the head this dismissal was actually staged against. Without the pin, the freshness guard would fall
    // back to ctx.headSha and treat this as fresh, retracting whatever bot approval currently sits on "sha7".
    const dismiss: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "stale approval retracted", dismissStaleApproval: true, expectedHeadSha: "evaluated-sha" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [dismiss]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(dismissLatestBotApproval).not.toHaveBeenCalled();
  });

  it("LIVE request_changes/approve without a reviewBody falls back to an empty string", async () => {
    const env = createTestEnv({});
    const bareRequestChanges: PlannedAgentAction = { actionClass: "request_changes", requiresApproval: false, reason: "blocked" };
    const bareApprove: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "passed" };
    await executeAgentMaintenanceActions(env, ctx(), [bareRequestChanges, bareApprove]);
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "REQUEST_CHANGES", "");
    // The approve still falls back to ctx.headSha ("sha7") as the pinned commit_id, same as the "LIVE: executes
    // each action class" test above — request_changes has no head-pinning of its own (unaffected).
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "", "sha7");
  });

  it("LIVE merge pins the GitHub merge to the action's reviewed head (expectedHeadSha) over the context head", async () => {
    const env = createTestEnv({});
    // A staged merge replayed on accept carries the REVIEWED head. Even when ctx.headSha is a newer live head,
    // the merge must pin to the reviewed commit so a force-pushed (un-reviewed) head can never be merged.
    const pinnedMerge: PlannedAgentAction = { actionClass: "merge", requiresApproval: false, reason: "clean", mergeMethod: "squash", expectedHeadSha: "reviewed-sha" };
    await executeAgentMaintenanceActions(env, ctx({ headSha: "live-sha" }), [pinnedMerge]);
    expect(mergePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7, { mergeMethod: "squash", sha: "reviewed-sha" });
    expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ expectedHeadSha: "reviewed-sha" }));
  });

  it("LIVE approve pins the review to the action's reviewed head (expectedHeadSha) over the context head, falling back to an empty body (#2262)", async () => {
    const env = createTestEnv({});
    // A staged approve replayed on accept carries the REVIEWED head — same pin as merge already has — and this
    // one also has no reviewBody set, exercising the empty-string fallback.
    const pinnedApprove: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "gate passed", expectedHeadSha: "reviewed-sha" };
    await executeAgentMaintenanceActions(env, ctx({ headSha: "live-sha" }), [pinnedApprove]);
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "", "reviewed-sha");
  });

  it("LIVE heuristic close is denied when live CI has since turned green (#2128)", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic", closeRequiresCiState: "failed" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "passed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [heuristicClose]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("CI state changed since planning (now: passed)");
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("LIVE heuristic close proceeds when live CI is still failing (#2128)", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic", closeRequiresCiState: "failed" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [heuristicClose]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
  });

  it("REGRESSION (#2364): a queued heuristic close still re-checks live CI after the approval-queue replay round trip", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic", closeRequiresCiState: "failed" };
    // Simulate the persist/replay path: stageForApproval calls actionParams() to persist the row, and accept
    // rebuilds it via pendingActionToPlanned(). Persist both the broad close kind and the narrower CI
    // dependency so queued red-CI closes still get the live-CI re-check without applying it to every heuristic close.
    const persisted = actionParams(heuristicClose);
    const replayed = pendingActionToPlanned({ actionClass: "close", params: persisted, reason: heuristicClose.reason });
    expect(replayed.closeKind).toBe("heuristic");
    expect(replayed.closeRequiresCiState).toBe("failed");
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "passed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [replayed]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("CI state changed since planning (now: passed)");
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION (#hard-blockers-not-ai-judgment): closeConcreteEvidence round-trips through the persist/replay round trip so a staged concrete-evidence close still bypasses the close-precision breaker at accept-time", () => {
    const concreteClose: PlannedAgentAction = { actionClass: "close", requiresApproval: true, reason: "hard blocker", closeComment: "closing", closeKind: "heuristic", closeConcreteEvidence: true };
    const persisted = actionParams(concreteClose);
    expect(persisted.closeConcreteEvidence).toBe(true);
    const replayed = pendingActionToPlanned({ actionClass: "close", params: persisted, reason: concreteClose.reason });
    expect(replayed.closeConcreteEvidence).toBe(true);
  });

  it("closeConcreteEvidence is omitted from persisted params when absent on the planned action (no stray key)", () => {
    const ambiguousClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "verdict failed", closeComment: "closing", closeKind: "heuristic" };
    const persisted = actionParams(ambiguousClose);
    expect(persisted).not.toHaveProperty("closeConcreteEvidence");
  });

  it("LIVE non-CI heuristic close proceeds when live CI is passing because the close reason is independent of CI", async () => {
    const env = createTestEnv({});
    // "not_required", not omitted: the planner always tags a fresh heuristic close explicitly (#2478).
    const gateClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "policy gate blocker", closeComment: "closing", closeKind: "heuristic", closeRequiresCiState: "not_required" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [gateClose]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
    expect(fetchLiveCiAggregate).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2478, flagged by the gate's own review of #2478): a LEGACY heuristic close staged before closeRequiresCiState existed (closeKind heuristic, field entirely absent) still re-checks live CI and is DENIED once CI has turned green", async () => {
    // Simulates a pending_agent_actions row persisted by code that predates #2478 -- closeKind: "heuristic" with
    // no closeRequiresCiState key at all, since the field didn't exist yet. The fix must NOT silently skip the
    // live-CI recheck for this row just because the new "not_required" tag is absent, or a stale CI-driven close
    // could execute after CI recovers.
    const env = createTestEnv({});
    const legacyHeuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "passed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [legacyHeuristicClose]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("CI state changed since planning (now: passed)");
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("a LEGACY heuristic close (closeRequiresCiState absent) still proceeds when live CI is genuinely still failing, matching the old pre-#2478 behavior", async () => {
    const env = createTestEnv({});
    const legacyHeuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [legacyHeuristicClose]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
  });

  it("LIVE non-heuristic close (linked-issue hard-rule) skips the live CI re-check entirely (#2128)", async () => {
    const env = createTestEnv({});
    const hardRuleClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "unlinked issue", closeComment: "closing", closeKind: "linked-issue-hard-rule" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [hardRuleClose]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(fetchLiveCiAggregate).not.toHaveBeenCalled();
  });

  it("LIVE merge is denied when live CI has since turned failing (#2128)", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationId: 127 }), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("live CI is no longer passing (now: failed)");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2364): LIVE merge is denied when live CI has since become pending, not just failed", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "pending", hasPending: true, hasVisiblePending: true, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("live CI is no longer passing (now: pending)");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2364): LIVE merge is denied when live CI has since become unverified (unreadable), not just failed", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "unverified", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("live CI is no longer passing (now: unverified)");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("the live CI re-check fails open on a token-mint error — it is defense-in-depth, not the primary gate (#2128)", async () => {
    const env = createTestEnv({});
    vi.mocked(createInstallationToken).mockRejectedValueOnce(new Error("mint failed"));
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7, { mergeMethod: "squash", sha: "sha7" });
  });

  it("LIVE label with labelOp=add + comment: adds the label AND posts the comment", async () => {
    const env = createTestEnv({});
    const flag: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "flag", label: "gittensory:pending-closure", labelOp: "add", comment: "⚠️ flagged" };
    await executeAgentMaintenanceActions(env, ctx(), [flag]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "gittensory:pending-closure", { createMissingLabel: true });
    expect(removePullRequestLabel).not.toHaveBeenCalled();
    expect(createIssueComment).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "⚠️ flagged");
  });

  it("LIVE label with labelOp=remove + comment: removes the label (never adds) AND posts the comment", async () => {
    const env = createTestEnv({});
    const clear: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "resolved", label: "gittensory:pending-closure", labelOp: "remove", comment: "✓ resolved" };
    await executeAgentMaintenanceActions(env, ctx(), [clear]);
    expect(removePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "gittensory:pending-closure");
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(createIssueComment).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "✓ resolved");
  });

  it("actionParams threads labelOp + comment so a staged flag replays faithfully", () => {
    const flag: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "flag", label: "gittensory:pending-closure", labelOp: "add", comment: "⚠️ flagged" };
    expect(actionParams(flag)).toEqual({ label: "gittensory:pending-closure", labelOp: "add", comment: "⚠️ flagged" });
  });

  it("LIVE approve persists the approved head SHA for re-approval idempotency", async () => {
    const env = createTestEnv({});
    await env.DB.prepare("insert into pull_requests (id, repo_full_name, number, title, state, head_sha, payload_json, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)")
      .bind("owner/repo#7", "owner/repo", 7, "t", "open", "sha7", "{}", "2026-06-23T00:00:00Z", "2026-06-23T00:00:00Z")
      .run();
    await executeAgentMaintenanceActions(env, ctx({ headSha: "sha7" }), [approve]);
    const row = await env.DB.prepare("select approved_head_sha from pull_requests where id = ?").bind("owner/repo#7").first<{ approved_head_sha: string | null }>();
    expect(row?.approved_head_sha).toBe("sha7");
  });

  it("PAUSED (per-repo): mutates nothing and audits denied", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ agentPaused: true }), [label, merge, updateBranch]);
    expect(outcomes.every((o) => o.outcome === "denied")).toBe(true);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(updatePullRequestBranch).not.toHaveBeenCalled();
    expect(JSON.parse((await auditFor(env, "label"))?.metadata_json ?? "{}")).toMatchObject({ mode: "paused" });
  });

  it("GLOBAL kill-switch (AGENT_ACTIONS_PAUSED) halts everything regardless of per-repo config", async () => {
    const env = createTestEnv({ AGENT_ACTIONS_PAUSED: "true" });
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ agentPaused: false }), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("DB-backed global freeze halts everything without a redeploy (#audit-§5.2)", async () => {
    const env = createTestEnv({}); // env-var brake OFF
    await setGlobalAgentFrozen(env, true, "operator");
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ agentPaused: false }), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(mergePullRequest).not.toHaveBeenCalled();
    // ...and clearing the freeze restores normal execution.
    await setGlobalAgentFrozen(env, false);
    const after = await executeAgentMaintenanceActions(env, ctx({ agentPaused: false }), [merge]);
    expect(after[0]?.outcome).toBe("completed");
    expect(mergePullRequest).toHaveBeenCalled();
  });

  it("isGlobalAgentFrozen fails open (false) on a read error — a D1 hiccup never freezes the fleet by itself", async () => {
    const broken = { ...createTestEnv({}), DB: null } as unknown as Env;
    expect(await isGlobalAgentFrozen(broken)).toBe(false);
  });

  it("isGlobalAgentFrozen's fail-open is never SILENT — a read error is observable, not indistinguishable from a genuine unfrozen state (#2125)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { ...createTestEnv({}), DB: null } as unknown as Env;
    expect(await isGlobalAgentFrozen(broken)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("global_kill_switch_read_error"));
    warn.mockRestore();
  });

  it("isGlobalAgentFrozen also warns (but still fails open) when the table exists but the singleton row is absent (#2125)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv({});
    await env.DB.prepare("DELETE FROM global_agent_controls WHERE id = 'singleton'").run();
    expect(await isGlobalAgentFrozen(env)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("global_kill_switch_row_missing"));
    warn.mockRestore();
  });

  it("auto_with_approval: stages the action (queued) instead of executing", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [{ ...merge, requiresApproval: true }]);
    expect(outcomes[0]?.outcome).toBe("queued");
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await auditFor(env, "merge"))?.outcome).toBe("queued");
  });

  it("denies planned actions when current per-action autonomy is no longer acting", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ autonomy: { approve: "auto" } }), [label, merge]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["denied", "denied"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(JSON.parse((await auditFor(env, "merge"))?.metadata_json ?? "{}")).toMatchObject({ autonomyLevel: "observe" });
  });

  it("pull-request writes without pull_requests:write are denied, but label and merge use their own permissions", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationPermissions: { pull_requests: "read", contents: "write", issues: "write" } }), [label, merge, updateBranch]);
    expect(outcomes.find((o) => o.actionClass === "label")?.outcome).toBe("completed");
    expect(outcomes.find((o) => o.actionClass === "merge")?.outcome).toBe("completed");
    expect(outcomes.find((o) => o.actionClass === "update_branch")?.outcome).toBe("denied");
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(updatePullRequestBranch).not.toHaveBeenCalled();
    expect((await auditFor(env, "update_branch"))?.outcome).toBe("denied");
  });

  it("REGRESSION: merge without contents:write is denied before any GitHub mutation", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationPermissions: { pull_requests: "write", contents: "read", issues: "write" } }), [merge]);
    expect(outcomes[0]).toMatchObject({ actionClass: "merge", outcome: "denied", detail: "contents: write not granted — maintainer must re-consent" });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  describe("write-permission denial cooldown (#selfhost-runtime-drift)", () => {
    async function auditCount(env: Env, actionClass: string): Promise<number> {
      const row = await env.DB.prepare("select count(*) as c from audit_events where event_type = ?")
        .bind(`agent.action.${actionClass}`)
        .first<{ c: number }>();
      return Number(row?.c ?? 0);
    }

    it("suppresses a repeated write-permission denial within the cooldown window — still denied, but not re-audited", async () => {
      const env = createTestEnv({});
      const deniedCtx = ctx({ installationId: 200, installationPermissions: { pull_requests: "write", contents: "read", issues: "write" } });

      const first = await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
      expect(first[0]).toMatchObject({ outcome: "denied", detail: "contents: write not granted — maintainer must re-consent" });
      expect(await auditCount(env, "merge")).toBe(1);

      const second = await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
      expect(second[0]?.outcome).toBe("denied");
      expect(second[0]?.detail).toContain("suppressed repeat");
      expect(await auditCount(env, "merge")).toBe(1); // no new audit row for the suppressed repeat
      expect(mergePullRequest).not.toHaveBeenCalled();

      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_agent_action_permission_denied_total{actionClass="merge"} 2');
      expect(metrics).toContain('gittensory_agent_action_permission_denied_suppressed_total{actionClass="merge"} 1');
    });

    it("resumes loud auditing once the cooldown window elapses", async () => {
      const env = createTestEnv({});
      const deniedCtx = ctx({ installationId: 201, installationPermissions: { pull_requests: "write", contents: "read", issues: "write" } });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
      try {
        await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
        expect(await auditCount(env, "merge")).toBe(1);

        vi.setSystemTime(new Date("2026-07-03T00:14:00Z")); // still inside the 15m cooldown
        await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
        expect(await auditCount(env, "merge")).toBe(1);

        vi.setSystemTime(new Date("2026-07-03T00:15:01Z")); // cooldown elapsed
        const afterCooldown = await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
        expect(afterCooldown[0]?.detail).toBe("contents: write not granted — maintainer must re-consent");
        expect(await auditCount(env, "merge")).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("scopes the cooldown per installation/repo/action-class — a different action class is not suppressed by another's denial", async () => {
      const env = createTestEnv({});
      const deniedCtx = ctx({ installationId: 202, installationPermissions: { pull_requests: "read", contents: "read", issues: "write" } });

      await executeAgentMaintenanceActions(env, deniedCtx, [merge]);
      const closeOutcome = await executeAgentMaintenanceActions(env, deniedCtx, [close]);

      expect(closeOutcome[0]?.detail).toBe("pull_requests: write not granted — maintainer must re-consent"); // loud, not suppressed
      expect(await auditCount(env, "close")).toBe(1);
    });

    it("scopes the cooldown per repo — the SAME installation denied on a different repo is not suppressed", async () => {
      const env = createTestEnv({});
      const perms = { pull_requests: "write" as const, contents: "read" as const, issues: "write" as const };
      await executeAgentMaintenanceActions(env, ctx({ installationId: 203, repoFullName: "owner/repo-a", installationPermissions: perms }), [merge]);
      const otherRepo = await executeAgentMaintenanceActions(env, ctx({ installationId: 203, repoFullName: "owner/repo-b", installationPermissions: perms }), [merge]);

      expect(otherRepo[0]?.detail).toBe("contents: write not granted — maintainer must re-consent");
      expect(await auditCount(env, "merge")).toBe(2); // one audit row per repo
    });

    it("REGRESSION (gate finding): a transient audit-write failure on the FIRST denial does not arm the cooldown — the retry attempts the audit again instead of being silently suppressed", async () => {
      const env = createTestEnv({});
      const deniedCtx = ctx({ installationId: 204, installationPermissions: { pull_requests: "write", contents: "read", issues: "write" } });
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

      await expect(executeAgentMaintenanceActions(env, deniedCtx, [merge])).rejects.toThrow("D1 write error");
      expect(await auditCount(env, "merge")).toBe(0); // the failed write never landed

      auditSpy.mockRestore();
      const retry = await executeAgentMaintenanceActions(env, deniedCtx, [merge]);

      // Loud, not suppressed — the cooldown was never armed by the failed first attempt.
      expect(retry[0]?.detail).toBe("contents: write not granted — maintainer must re-consent");
      expect(await auditCount(env, "merge")).toBe(1);
    });

    it("REGRESSION (gate finding): scopes the cooldown per PR — a denial on a DIFFERENT PR in the same installation/repo/action-class is not suppressed", async () => {
      const env = createTestEnv({});
      const perms = { pull_requests: "write" as const, contents: "read" as const, issues: "write" as const };

      const prA = await executeAgentMaintenanceActions(env, ctx({ installationId: 205, pullNumber: 501, installationPermissions: perms }), [merge]);
      const prB = await executeAgentMaintenanceActions(env, ctx({ installationId: 205, pullNumber: 502, installationPermissions: perms }), [merge]);

      // Both denials are loud — PR B's cooldown key differs from PR A's, so it must never be silently
      // suppressed by PR A's already-armed cooldown within the same 15m window.
      expect(prA[0]).toMatchObject({ outcome: "denied", detail: "contents: write not granted — maintainer must re-consent" });
      expect(prB[0]).toMatchObject({ outcome: "denied", detail: "contents: write not granted — maintainer must re-consent" });
      expect(await auditCount(env, "merge")).toBe(2); // one audit row per PR, not one shared row
    });
  });

  it("#label-close-split-brain: a coupled anti-abuse label+close pair (matching closeKind) BOTH complete when the close succeeds", async () => {
    const env = createTestEnv({});
    const coupledClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", closeComment: "closing", closeKind: "contributor_cap" };
    const coupledLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add", closeKind: "contributor_cap" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [coupledClose, coupledLabel]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["completed", "completed"]);
    expect(closePullRequest).toHaveBeenCalledTimes(1);
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
  });

  it("#label-close-split-brain (confirmed root cause of PR-cap miscounting): a coupled anti-abuse label is SKIPPED, not posted, when its paired close is denied for lacking pull_requests:write — `label` mutates via the Issues API and is otherwise exempt from that gate, so without this correlation a PR could be mislabeled 'over-contributor-limit' while it stays open forever", async () => {
    const env = createTestEnv({});
    const coupledClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", closeComment: "closing", closeKind: "contributor_cap" };
    const coupledLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add", closeKind: "contributor_cap" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationPermissions: { pull_requests: "read", issues: "write" } }), [coupledClose, coupledLabel]);
    expect(outcomes[0]).toMatchObject({ actionClass: "close", outcome: "denied" });
    expect(outcomes[1]).toMatchObject({ actionClass: "label", outcome: "denied" });
    expect(outcomes[1]?.detail).toContain("paired contributor_cap close did not complete");
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(ensurePullRequestLabel).not.toHaveBeenCalled(); // the bug: this used to be called anyway
    expect((await auditFor(env, "label"))?.outcome).toBe("denied");
  });

  it("#label-close-split-brain: an UNRELATED plain label (no closeKind — e.g. a review_state_label disposition) is unaffected by a same-batch close's outcome", async () => {
    const env = createTestEnv({});
    const unrelatedClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "heuristic", closeComment: "closing", closeKind: "heuristic" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationPermissions: { pull_requests: "read", issues: "write" } }), [unrelatedClose, label]);
    expect(outcomes[0]).toMatchObject({ actionClass: "close", outcome: "denied" });
    expect(outcomes[1]).toMatchObject({ actionClass: "label", outcome: "completed" }); // no closeKind on `label` -> not correlated
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
  });

  it("#label-close-split-brain: a label's closeKind with NO matching close anywhere in the batch is unaffected (coupledCloseOutcome finds nothing, so the correlation guard never blocks it)", async () => {
    const env = createTestEnv({});
    // A close of a DIFFERENT closeKind precedes the label — the label's own "contributor_cap" closeKind has no
    // matching close in this batch at all, so the scan exhausts without a match.
    const differentKindClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "blacklisted contributor", closeComment: "closing", closeKind: "blacklist" };
    const mismatchedLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add", closeKind: "contributor_cap" };
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [differentKindClose, mismatchedLabel]);
    expect(outcomes[0]).toMatchObject({ actionClass: "close", outcome: "completed" });
    expect(outcomes[1]).toMatchObject({ actionClass: "label", outcome: "completed" });
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
  });

  it("#label-close-split-brain: a coupled label still applies when the paired close is only QUEUED for approval (not denied/errored) — both actions share the SAME requiresApproval, so this is the normal staged-together path, not a split-brain", async () => {
    const env = createTestEnv({});
    const coupledClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", closeComment: "closing", closeKind: "contributor_cap" };
    const coupledLabel: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add", closeKind: "contributor_cap" };
    // Force the close's OWN autonomy to auto_with_approval (queued) while the label's stays auto (would complete
    // on its own) -- an artificial divergence from the planner's normal "both share requiresApproval" shape, used
    // here purely to prove the correlation reads the close's REAL recorded outcome ("queued"), not just falls
    // through to "denied" for anything other than "completed".
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ autonomy: { label: "auto", close: "auto_with_approval" } }), [{ ...coupledClose, requiresApproval: true }, coupledLabel]);
    expect(outcomes[0]).toMatchObject({ actionClass: "close", outcome: "queued" });
    expect(outcomes[1]).toMatchObject({ actionClass: "label", outcome: "completed" });
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
  });

  it("DRY-RUN: records the intent without any GitHub call, audited with mode=dry_run", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ agentDryRun: true }), [label, merge]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["dry_run", "dry_run"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    const audit = await auditFor(env, "merge");
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run" });
  });

  it("LIVE with minimal action payloads: denies PR mutations when no reviewed head can be pinned", async () => {
    const env = createTestEnv({});
    const bare = (actionClass: PlannedAgentAction["actionClass"]): PlannedAgentAction => ({ actionClass, requiresApproval: false, reason: "x" });
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ headSha: undefined }), [bare("label"), bare("request_changes"), bare("approve"), bare("merge"), bare("close"), bare("update_branch")]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["denied", "denied", "denied", "denied", "denied", "denied"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(createPullRequestReview).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(updatePullRequestBranch).not.toHaveBeenCalled();
    expect(createIssueComment).not.toHaveBeenCalled();
    expect(fetchPullRequestFreshness).not.toHaveBeenCalled();
    expect(outcomes[0]?.detail).toContain("head guard unavailable");
  });

  it("LIVE: denies mutations when the PR was force-pushed after the action was planned", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "sha7",
      liveHeadSha: "newsha",
      liveState: "open",
    });

    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [label, approve, merge, close, updateBranch]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["denied", "denied", "denied", "denied", "denied"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(createPullRequestReview).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(updatePullRequestBranch).not.toHaveBeenCalled();
    expect(outcomes[0]?.detail).toContain("PR head changed from sha7 to newsha");
    expect(outcomes.find((outcome) => outcome.actionClass === "update_branch")?.detail).toContain("PR head changed from sha7 to newsha");
    const audit = await auditFor(env, "merge");
    expect(audit?.outcome).toBe("denied");
  });

  it("LIVE: rechecks freshness after update_branch before later PR-visible actions", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchPullRequestFreshness)
      .mockResolvedValueOnce({
        status: "current",
        liveHeadSha: "sha7",
        liveState: "open",
      })
      .mockResolvedValueOnce({
        status: "stale",
        reason: "head_changed",
        expectedHeadSha: "sha7",
        liveHeadSha: "sha8",
        liveState: "open",
      });

    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [updateBranch, approve]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["completed", "denied"]);
    expect(updatePullRequestBranch).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "sha7");
    expect(createPullRequestReview).not.toHaveBeenCalled();
    expect(fetchPullRequestFreshness).toHaveBeenCalledTimes(2);
    expect(fetchPullRequestFreshness).toHaveBeenNthCalledWith(1, env, expect.objectContaining({ expectedHeadSha: "sha7" }));
    expect(fetchPullRequestFreshness).toHaveBeenNthCalledWith(2, env, expect.objectContaining({ expectedHeadSha: "sha7" }));
    expect(outcomes[1]?.detail).toContain("PR head changed from sha7 to sha8");
  });

  it("LIVE: denies mutations when the PR is already closed", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "closed",
      expectedHeadSha: "sha7",
      liveHeadSha: "sha7",
      liveState: "closed",
    });

    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [close]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        actionClass: "close",
        outcome: "denied",
        detail: expect.stringContaining("no longer open"),
      }),
    ]);
    expect(createIssueComment).not.toHaveBeenCalled();
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("records a failed mutation as error rather than swallowing it", async () => {
    const env = createTestEnv({});
    vi.mocked(mergePullRequest).mockRejectedValueOnce(new Error("Pull Request is not mergeable"));
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("error");
    expect(outcomes[0]?.detail).toMatch(/not mergeable/i);
    expect((await auditFor(env, "merge"))?.outcome).toBe("error");
  });

  it("REGRESSION: a generic GitHub 403 merge rejection does not immediately pin merge_blocked_sha", async () => {
    const env = createTestEnv({});
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "c" }, head: { sha: "sha7" }, labels: [], body: "" });
    vi.mocked(mergePullRequest).mockRejectedValueOnce(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));

    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);

    expect(outcomes[0]).toMatchObject({ actionClass: "merge", outcome: "error" });
    const row = await env.DB.prepare(
      "select merge_attempt_count as mergeAttemptCount, merge_blocked_sha as mergeBlockedSha, merge_blocked_reason as mergeBlockedReason from pull_requests where repo_full_name = ? and number = ?",
    )
      .bind("owner/repo", 7)
      .first<{ mergeAttemptCount: number; mergeBlockedSha: string | null; mergeBlockedReason: string | null }>();
    expect(row).toEqual({ mergeAttemptCount: 1, mergeBlockedSha: null, mergeBlockedReason: null });
    const blocked = await env.DB.prepare("select count(*) as count from audit_events where event_type = ?")
      .bind("agent.action.merge_blocked")
      .first<{ count: number }>();
    expect(blocked?.count).toBe(0);
  });

  it("opportunistically refreshes installation health when a PR-write mutation fails with a 403 (#2265)", async () => {
    const env = createTestEnv({});
    vi.mocked(closePullRequest).mockRejectedValueOnce(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [close]);
    expect(outcomes[0]?.outcome).toBe("error");
    expect(refreshInstallationHealthForInstallation).toHaveBeenCalledTimes(1);
    expect(refreshInstallationHealthForInstallation).toHaveBeenCalledWith(env, 123);
  });

  it("does not refresh installation health for a non-403 mutation failure (#2265)", async () => {
    const env = createTestEnv({});
    vi.mocked(closePullRequest).mockRejectedValueOnce(new Error("network timeout"));
    await executeAgentMaintenanceActions(env, ctx(), [close]);
    expect(refreshInstallationHealthForInstallation).not.toHaveBeenCalled();
  });

  it("does not refresh installation health on a 403 from a non-PR-write action (label uses issues:write, not pull_requests) (#2265)", async () => {
    const env = createTestEnv({});
    vi.mocked(ensurePullRequestLabel).mockRejectedValueOnce(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
    await executeAgentMaintenanceActions(env, ctx(), [label]);
    expect(refreshInstallationHealthForInstallation).not.toHaveBeenCalled();
  });

  it("does not refresh installation health for rate-limit or operation-specific forbidden 403s (#2265)", async () => {
    const env = createTestEnv({});
    vi.mocked(updatePullRequestBranch)
      .mockRejectedValueOnce(Object.assign(new Error("secondary rate limit: please retry later"), { status: 403 }))
      .mockRejectedValueOnce(Object.assign(new Error("Update branch is not allowed for this pull request"), { status: 403 }));

    await executeAgentMaintenanceActions(env, ctx({ installationId: 124 }), [updateBranch, updateBranch]);

    expect(refreshInstallationHealthForInstallation).not.toHaveBeenCalled();
  });

  it("debounces permission-looking installation health refreshes per installation (#2265)", async () => {
    const env = createTestEnv({});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T00:00:00Z"));
    vi.mocked(closePullRequest).mockRejectedValue(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));

    try {
      await executeAgentMaintenanceActions(env, ctx({ installationId: 125 }), [close]);
      await executeAgentMaintenanceActions(env, ctx({ installationId: 125 }), [close]);
      vi.setSystemTime(new Date("2026-07-02T00:05:01Z"));
      await executeAgentMaintenanceActions(env, ctx({ installationId: 125 }), [close]);

      expect(refreshInstallationHealthForInstallation).toHaveBeenCalledTimes(2);
      expect(refreshInstallationHealthForInstallation).toHaveBeenNthCalledWith(1, env, 125);
      expect(refreshInstallationHealthForInstallation).toHaveBeenNthCalledWith(2, env, 125);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a failed installation-health refresh — best-effort, does not affect the recorded outcome (#2265)", async () => {
    const env = createTestEnv({});
    vi.mocked(closePullRequest).mockRejectedValueOnce(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
    vi.mocked(refreshInstallationHealthForInstallation).mockRejectedValueOnce(new Error("refresh boom"));
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationId: 126 }), [close]);
    expect(outcomes[0]?.outcome).toBe("error");
    expect(refreshInstallationHealthForInstallation).toHaveBeenCalledWith(env, 126);
    expect((await auditFor(env, "close"))?.outcome).toBe("error");
  });
});

describe("moderation-rules engine escalation (#selfhost-mod-engine)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPullRequestFreshness).mockImplementation(async (_env, args) => ({
      status: "current",
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
    }));
    // clearAllMocks() resets call history but does NOT drain a queued mockRejectedValueOnce/mockResolvedValueOnce
    // left over from an earlier test elsewhere in this file (e.g. the installation-health-refresh tests above
    // queue a one-time closePullRequest rejection) -- re-pin the base implementation explicitly so this describe
    // block's "the close actually completed" assumption is never at the mercy of file-level test order.
    vi.mocked(closePullRequest).mockResolvedValue({ state: "closed" });
  });

  const coupledClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", closeComment: "closing", closeKind: "contributor_cap" };
  const coupledLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add", closeKind: "contributor_cap" };

  it("OFF by default: a completed contributor_cap close applies NO mod label when the global moderation config is disabled (the DB default)", async () => {
    const env = createTestEnv({});
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", expect.anything());
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:banned", expect.anything());
  });

  it("applies the default mod:warning label at the 1st lifetime violation once the global config is enabled", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
  });

  it("4 violations -> warning only; the 5th (default threshold) escalates to mod:banned + auto-blacklists the login", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    // Each iteration is a DIFFERENT PR (distinct pullNumber) -- 4 separate enforcement actions, not the same
    // one replayed 4 times (the idempotency fix above correctly collapses same-target replays to ONE violation).
    for (let i = 0; i < 4; i++) {
      vi.clearAllMocks();
      await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", pullNumber: 100 + i }), [coupledClose, coupledLabel]);
      expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 100 + i, "mod:warning", { createMissingLabel: true });
      expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 100 + i, "mod:banned", expect.anything());
    }
    vi.clearAllMocks();
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", pullNumber: 104 }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 104, "mod:banned", { createMissingLabel: true });
    const blacklist = await getGlobalContributorBlacklist(env);
    expect(blacklist?.map((entry) => entry.login)).toContain("farmer99");
  });

  it("does NOT auto-blacklist when autoBlacklistOnBan is off, even at the ban threshold", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 1, autoBlacklistOnBan: false });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:banned", { createMissingLabel: true });
    const blacklist = await getGlobalContributorBlacklist(env);
    expect(blacklist?.map((entry) => entry.login)).not.toContain("farmer99");
  });

  it("does not double-add an actor who is already on the global blacklist", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 1 });
    // Two DISTINCT PRs (different pullNumber) -- two genuinely separate violations, not a same-target replay
    // (which the idempotency fix would correctly no-op before ever reaching the blacklist-membership check).
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", pullNumber: 7 }), [coupledClose, coupledLabel]);
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", pullNumber: 8 }), [{ ...coupledClose }, { ...coupledLabel }]);
    const blacklist = await getGlobalContributorBlacklist(env);
    expect(blacklist?.filter((entry) => entry.login === "farmer99")).toHaveLength(1);
  });

  it("per-repo moderationGateMode 'off' force-disables the layer even when the global config is enabled", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", moderationSettings: { moderationGateMode: "off" } }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", expect.anything());
  });

  it("per-repo moderationGateMode 'enabled' force-enables the layer even when the global config is disabled (the default)", async () => {
    const env = createTestEnv({});
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", moderationSettings: { moderationGateMode: "enabled" } }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
  });

  it("per-repo moderationRules override EXCLUDING contributor_cap means a contributor_cap close on THIS repo does not count as a violation", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", moderationSettings: { moderationRules: ["blacklist"] } }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", expect.anything());
  });

  it("REGRESSION (gate-flagged): the escalation count is scoped to the CURRENTLY-effective rule types, not every rule type ever recorded -- an excluded rule's historical violations must not push the count toward the ban threshold", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 2 });
    // A contributor_cap violation recorded earlier (e.g. from a repo/period where cap DID count).
    await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?, ?, ?, ?, 'completed', 'old', '{}', ?)")
      .bind(crypto.randomUUID(), MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, "farmer99", "owner/repo#1", new Date().toISOString())
      .run();
    // THIS repo only cares about blacklist -- a blacklist close here should count ONLY the blacklist history,
    // not the pre-existing contributor_cap violation, so the total stays at 1 (< threshold 2) -> warning.
    const blacklistClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "blacklisted contributor", closeComment: "closing", closeKind: "blacklist" };
    const blacklistLabel: PlannedAgentAction = { actionClass: "label", autonomyClass: "close", requiresApproval: false, reason: "blacklisted contributor", label: "slop", labelOp: "add", closeKind: "blacklist" };
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", moderationSettings: { moderationRules: ["blacklist"] } }), [blacklistClose, blacklistLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:banned", expect.anything());
  });

  it("per-repo custom label overrides win over the global config's label", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, warningLabel: "global:warn" });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", moderationSettings: { moderationWarningLabel: "repo:warn" } }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "repo:warn", { createMissingLabel: true });
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "global:warn", expect.anything());
  });

  it("no escalation in dry-run mode -- a mutation that didn't really happen must not count as a violation", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", agentDryRun: true }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
  });

  it("no escalation when the close is denied (not completed) -- e.g. the label-close split-brain guard's own denial path", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99", installationPermissions: { pull_requests: "read", issues: "write" } }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", expect.anything());
  });

  it("no escalation for a close with no author login (defensive -- should not happen for a real PR/issue)", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: undefined }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", expect.anything());
  });

  it("no escalation for an UNRELATED heuristic close (not one of the three moderation-tracked rule types)", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true });
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "gate failed", closeComment: "closing", closeKind: "heuristic" };
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [heuristicClose]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
  });

  it("violationDecayDays (rolling window) excludes an old violation from the ban threshold, unlike the permanent-tally default", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 2, violationDecayDays: 1 });
    // A violation from 10 days ago -- outside the 1-day decay window -- must NOT count toward the threshold.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?, ?, ?, ?, 'completed', 'old', '{}', ?)")
      .bind(crypto.randomUUID(), "moderation.violation.contributor_cap", "farmer99", "owner/repo#1", tenDaysAgo)
      .run();
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    // Only the JUST-recorded violation counts (1 < banThreshold 2) -> warning, not banned.
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:banned", expect.anything());
  });

  it("REGRESSION (gate-flagged): a webhook redelivery / queue retry that re-executes the SAME close (same repo+number) does not double-count the violation or escalate past what the single real enforcement action warrants", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 2 });
    // First pass: this contributor's ONLY violation -> warning (1 < threshold 2).
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
    vi.clearAllMocks();
    vi.mocked(closePullRequest).mockResolvedValue({ state: "closed" });
    // A REPLAY of the exact same close (same pullNumber, same repo) -- e.g. GitHub redelivers the webhook, or
    // the queue job retries after the mutation already succeeded. Must NOT count as a 2nd violation.
    await executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:banned", expect.anything());
  });

  it("REGRESSION (gate-flagged): an absurdly large violationDecayDays does not throw on the live close path (clamped before it ever reaches Date arithmetic)", async () => {
    const env = createTestEnv({});
    await upsertGlobalModerationConfig(env, { enabled: true, violationDecayDays: Number.MAX_SAFE_INTEGER });
    await expect(executeAgentMaintenanceActions(env, ctx({ authorLogin: "farmer99" }), [coupledClose, coupledLabel])).resolves.not.toThrow();
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "mod:warning", { createMissingLabel: true });
  });
});

function issueCtx(over: Partial<IssueActionExecutionContext> = {}): IssueActionExecutionContext {
  return {
    installationId: 123,
    repoFullName: "owner/repo",
    issueNumber: 42,
    autonomy: { label: "auto", close: "auto" },
    agentPaused: false,
    agentDryRun: false,
    ...over,
  };
}

const issueLabel: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "over the per-contributor open-item cap", label: "over-contributor-limit", labelOp: "add" };
const issueClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "over the per-contributor open-item cap", closeComment: "closing this issue", closeKind: "contributor_cap" };

describe("executeIssueMaintenanceActions (#2270 issue-side actuation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LIVE: labels + closes an issue via the issues-endpoint primitives and audits completed", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx(), [issueLabel, issueClose]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["completed", "completed"]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 42, "over-contributor-limit", { createMissingLabel: true });
    expect(createIssueComment).toHaveBeenCalledWith(env, 123, "owner/repo", 42, "closing this issue");
    expect(closeIssue).toHaveBeenCalledWith(env, 123, "owner/repo", 42);
    expect(closePullRequest).not.toHaveBeenCalled(); // the PR endpoint must never be hit for an issue number
    expect((await auditFor(env, "close"))?.outcome).toBe("completed");
  });

  it("a close with no closeComment posts no comment (defensive — the contributor_cap planner always sets one)", async () => {
    const env = createTestEnv({});
    const { closeComment: _closeComment, ...closeWithoutComment } = issueClose;
    await executeIssueMaintenanceActions(env, issueCtx(), [closeWithoutComment]);
    expect(createIssueComment).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledTimes(1);
  });

  it("a label action with no label name falls back to an empty string (defensive — the contributor_cap planner always sets one)", async () => {
    const env = createTestEnv({});
    const { label: _label, ...labelWithoutName } = issueLabel;
    await executeIssueMaintenanceActions(env, issueCtx(), [labelWithoutName]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 42, "", { createMissingLabel: true });
  });

  it("PAUSED (per-repo): mutates nothing and audits denied", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ agentPaused: true }), [issueLabel, issueClose]);
    expect(outcomes.every((o) => o.outcome === "denied")).toBe(true);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
    expect(JSON.parse((await auditFor(env, "close"))?.metadata_json ?? "{}")).toMatchObject({ mode: "paused" });
  });

  it("GLOBAL kill-switch halts everything regardless of per-repo config", async () => {
    const env = createTestEnv({ AGENT_ACTIONS_PAUSED: "true" });
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ agentPaused: false }), [issueClose]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("denies when current per-action autonomy is no longer acting", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ autonomy: { label: "observe", close: "observe" } }), [issueLabel, issueClose]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["denied", "denied"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("DRY-RUN: records the intent without any GitHub call, audited with mode=dry_run", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ agentDryRun: true }), [issueLabel, issueClose]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["dry_run", "dry_run"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
    const audit = await auditFor(env, "close");
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run" });
  });

  it("auto_with_approval is DENIED, not staged — issue-side staging is not implemented (#2270 known scope limit)", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ autonomy: { label: "auto_with_approval", close: "auto_with_approval" } }), [
      { ...issueLabel, requiresApproval: true },
      { ...issueClose, requiresApproval: true },
    ]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["denied", "denied"]);
    expect(ensurePullRequestLabel).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
    const detail = await env.DB.prepare("select detail from audit_events where event_type = 'agent.action.close' order by created_at desc limit 1").first<{ detail: string }>();
    expect(detail?.detail).toMatch(/issue-side staging is not yet supported/);
  });

  it("denies an unsupported action class defensively (this executor only handles label/close)", async () => {
    const env = createTestEnv({});
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx({ autonomy: { merge: "auto" } }), [
      { actionClass: "merge", requiresApproval: false, reason: "n/a", mergeMethod: "squash" },
    ]);
    expect(outcomes[0]?.outcome).toBe("denied");
    const detail = await env.DB.prepare("select detail from audit_events where event_type = 'agent.action.merge' order by created_at desc limit 1").first<{ detail: string }>();
    expect(detail?.detail).toMatch(/unsupported action class for an issue/);
  });

  it("records a failed mutation as error rather than swallowing it", async () => {
    const env = createTestEnv({});
    vi.mocked(closeIssue).mockRejectedValueOnce(new Error("github 500"));
    const outcomes = await executeIssueMaintenanceActions(env, issueCtx(), [issueClose]);
    expect(outcomes[0]?.outcome).toBe("error");
    expect((await auditFor(env, "close"))?.outcome).toBe("error");
  });
});

describe("pendingClosureLabelApplied (#1136 Pass-2 trigger)", () => {
  const labelAdd: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "flag", label: AGENT_LABEL_PENDING_CLOSURE, labelOp: "add" };
  const approve2: PlannedAgentAction = { actionClass: "approve", requiresApproval: false, reason: "ok" };
  const out = (outcome: AgentActionOutcome["outcome"], actionClass: AgentActionOutcome["actionClass"] = "label"): AgentActionOutcome => ({ actionClass, outcome, detail: "" });

  it("true when the pending-closure label-add COMPLETED", () => {
    expect(pendingClosureLabelApplied([labelAdd], [out("completed")])).toBe(true);
  });
  it("false when the label action did not complete (queued/error/dry_run/denied → state not established)", () => {
    for (const o of ["queued", "error", "dry_run", "denied"] as const) expect(pendingClosureLabelApplied([labelAdd], [out(o)])).toBe(false);
  });
  it("false when no pending-closure label-add is planned", () => {
    expect(pendingClosureLabelApplied([approve2], [out("completed", "approve")])).toBe(false);
  });
  it("false for a label REMOVE — only an ADD establishes the pending-closure flag", () => {
    expect(pendingClosureLabelApplied([{ ...labelAdd, labelOp: "remove" }], [out("completed")])).toBe(false);
  });
  it("false for a completed add of a DIFFERENT label", () => {
    expect(pendingClosureLabelApplied([{ ...labelAdd, label: "some-other-label" }], [out("completed")])).toBe(false);
  });
  it("matches the label's outcome by its OWN plan index (not assuming index 0)", () => {
    expect(pendingClosureLabelApplied([approve2, labelAdd], [out("completed", "approve"), out("completed")])).toBe(true);
    expect(pendingClosureLabelApplied([approve2, labelAdd], [out("completed", "approve"), out("error")])).toBe(false);
  });
  it("false when there is no outcome at the label's index (outcomes shorter than the plan)", () => {
    expect(pendingClosureLabelApplied([approve2, labelAdd], [out("completed", "approve")])).toBe(false);
  });
});
