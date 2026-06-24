import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
}));
vi.mock("../../src/github/labels", () => ({
  ensurePullRequestLabel: vi.fn(async () => ({ applied: true, created: false })),
}));

import { mergePullRequest } from "../../src/github/pr-actions";
import { ensurePullRequestLabel } from "../../src/github/labels";
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
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });

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
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });

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
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });

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
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });
    const result = await decidePendingAgentAction(env, { id: action.id, decision: "accept", decidedBy: "owner" });
    expect(result.status).toBe("accepted"); // the decision is recorded...
    expect(result.executionOutcome).toBe("denied"); // ...but the action could not run
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.pending_action.accepted").first<{ outcome: string }>())?.outcome).toBe("error");
  });

  it("actionParams extracts only the field for the action class", () => {
    expect(actionParams({ actionClass: "label", requiresApproval: false, reason: "x", label: "L" })).toEqual({ label: "L" });
    expect(actionParams({ actionClass: "request_changes", requiresApproval: false, reason: "x", reviewBody: "B" })).toEqual({ reviewBody: "B" });
    expect(actionParams({ actionClass: "merge", requiresApproval: false, reason: "x", mergeMethod: "rebase" })).toEqual({ mergeMethod: "rebase" });
    expect(actionParams({ actionClass: "close", requiresApproval: false, reason: "x", closeComment: "C" })).toEqual({ closeComment: "C" });
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
