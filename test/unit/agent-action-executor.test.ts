import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
  updatePullRequestBranch: vi.fn(async () => undefined),
}));
vi.mock("../../src/github/labels", () => ({
  ensurePullRequestLabel: vi.fn(async () => ({ applied: true, created: false })),
}));

import { closePullRequest, createIssueComment, createPullRequestReview, mergePullRequest, updatePullRequestBranch } from "../../src/github/pr-actions";
import { ensurePullRequestLabel } from "../../src/github/labels";
import { actionParams, executeAgentMaintenanceActions, type AgentActionExecutionContext } from "../../src/services/agent-action-executor";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
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
    expect((await auditFor(env, "merge"))?.outcome).toBe("completed");
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

  it("LIVE with minimal action payloads: applies defensive defaults and omits the sha guard when headSha is absent", async () => {
    const env = createTestEnv({});
    const bare = (actionClass: PlannedAgentAction["actionClass"]): PlannedAgentAction => ({ actionClass, requiresApproval: false, reason: "x" });
    await executeAgentMaintenanceActions(env, ctx({ headSha: undefined }), [bare("label"), bare("request_changes"), bare("approve"), bare("merge"), bare("close")]);
    expect(ensurePullRequestLabel).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "", { createMissingLabel: true });
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "REQUEST_CHANGES", "");
    expect(createPullRequestReview).toHaveBeenCalledWith(env, 123, "owner/repo", 7, "APPROVE", "");
    expect(mergePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7, { mergeMethod: "squash" }); // no sha guard
    expect(closePullRequest).toHaveBeenCalledWith(env, 123, "owner/repo", 7);
    expect(createIssueComment).not.toHaveBeenCalled(); // no closeComment → no comment posted
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
