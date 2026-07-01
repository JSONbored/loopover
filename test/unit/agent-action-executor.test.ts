import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
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
  fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] })),
}));

import { closePullRequest, createIssueComment, createPullRequestReview, dismissLatestBotApproval, mergePullRequest, updatePullRequestBranch } from "../../src/github/pr-actions";
import { ensurePullRequestLabel, removePullRequestLabel } from "../../src/github/labels";
import { fetchPullRequestFreshness } from "../../src/github/pr-freshness";
import { createInstallationToken } from "../../src/github/app";
import { fetchLiveCiAggregate } from "../../src/github/backfill";
import { actionParams, executeAgentMaintenanceActions, pendingActionToPlanned, pendingClosureLabelApplied, type AgentActionExecutionContext, type AgentActionOutcome } from "../../src/services/agent-action-executor";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
import { AGENT_LABEL_PENDING_CLOSURE } from "../../src/review/linked-issue-hard-rules";
import { isGlobalAgentFrozen, setGlobalAgentFrozen, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function ctx(over: Partial<AgentActionExecutionContext> = {}): AgentActionExecutionContext {
  return {
    installationId: 123,
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "sha7",
    autonomy: { label: "auto", request_changes: "auto", approve: "auto", merge: "auto", close: "auto", update_branch: "auto" },
    agentPaused: false,
    agentDryRun: false,
    installationPermissions: { pull_requests: "write", issues: "write" },
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
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "lgtm");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7, { mergeMethod: "squash", sha: "sha7" });
    expect(createIssueComment).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "closing");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
    expect(updatePullRequestBranch).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "sha7");
    expect(fetchPullRequestFreshness).toHaveBeenCalledTimes(6);
    expect((await auditFor(env, "merge"))?.outcome).toBe("completed");
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
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "");
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

  it("LIVE heuristic close is denied when live CI has since turned green (#2128)", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "passed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [heuristicClose]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("CI state changed since planning (now: passed)");
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("LIVE heuristic close proceeds when live CI is still failing (#2128)", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic" };
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [heuristicClose]);
    expect(outcomes[0]?.outcome).toBe("completed");
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
  });

  it("REGRESSION (#2364): a queued heuristic close still re-checks live CI after the approval-queue replay round trip", async () => {
    const env = createTestEnv({});
    const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failed", closeComment: "closing", closeKind: "heuristic" };
    // Simulate the persist/replay path: stageForApproval calls actionParams() to persist the row, and accept
    // rebuilds it via pendingActionToPlanned(). Without persisting closeKind, the rebuilt action would lose the
    // discriminator the live-CI re-check keys on, silently skipping it for every accepted queued heuristic close.
    const persisted = actionParams(heuristicClose);
    const replayed = pendingActionToPlanned({ actionClass: "close", params: persisted, reason: heuristicClose.reason });
    expect(replayed.closeKind).toBe("heuristic");
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "passed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [replayed]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("CI state changed since planning (now: passed)");
    expect(closePullRequest).not.toHaveBeenCalled();
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
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "failed", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("live CI is no longer passing (now: failed)");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2364): LIVE merge is denied when live CI has since become pending, not just failed", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "pending", hasPending: true, hasVisiblePending: true, failingDetails: [], nonRequiredFailingDetails: [] });
    const outcomes = await executeAgentMaintenanceActions(env, ctx(), [merge]);
    expect(outcomes[0]?.outcome).toBe("denied");
    expect(outcomes[0]?.detail).toContain("live CI is no longer passing (now: pending)");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION (#2364): LIVE merge is denied when live CI has since become unverified (unreadable), not just failed", async () => {
    const env = createTestEnv({});
    vi.mocked(fetchLiveCiAggregate).mockResolvedValueOnce({ ciState: "unverified", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
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

  it("PR-write without pull_requests:write → denied (re-consent), but label still runs (issues:write)", async () => {
    const env = createTestEnv({});
    const outcomes = await executeAgentMaintenanceActions(env, ctx({ installationPermissions: { pull_requests: "read", issues: "write" } }), [label, merge, updateBranch]);
    expect(outcomes.find((o) => o.actionClass === "label")?.outcome).toBe("completed");
    expect(outcomes.find((o) => o.actionClass === "merge")?.outcome).toBe("denied");
    expect(outcomes.find((o) => o.actionClass === "update_branch")?.outcome).toBe("denied");
    expect(ensurePullRequestLabel).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(updatePullRequestBranch).not.toHaveBeenCalled();
    expect((await auditFor(env, "merge"))?.outcome).toBe("denied");
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
