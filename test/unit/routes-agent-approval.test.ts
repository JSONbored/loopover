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
// Without this mock, an unconfigured GITHUB_APP_PRIVATE_KEY leaves the accept-time live-recheck token mint
// undefined; fetchLiveCiAggregate then FULFILLS with ciState "unverified" (not a rejection), which the
// accept-time staleness check (agent-approval-queue.ts) now treats as non-"passed" — a genuine stale signal,
// not a fail-open case. #2364's live CI re-check (in executeAgentMaintenanceActions) runs for every
// merge/heuristic-close accept too. Default to "passed" so the existing "accept executes the staged merge"
// happy path executes live instead of being (correctly) denied for CI neither test was simulating.
vi.mock("../../src/github/backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/backfill")>();
  return {
    ...actual,
    fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null })),
  };
});

import { mergePullRequest } from "../../src/github/pr-actions";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createApp } from "../../src/api/routes";
import { createPendingAgentActionIfAbsent, getPendingAgentAction, recordAuditEvent, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const app = createApp();
const headers = (env: Env) => ({ authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`, "content-type": "application/json" });

async function seedPending(env: Env) {
  await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
  await upsertInstallation(env, {
    installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
    repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
  });
  await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
  const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
  return action;
}

describe("agent approval-queue routes (#779)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists a repo's pending actions (maintainer-scoped)", async () => {
    const env = createTestEnv();
    await seedPending(env);
    const res = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ repoFullName: "owner/repo", pendingActions: [{ actionClass: "merge", status: "pending" }] });
  });

  it("requires authentication", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/agent/pending-actions", {}, env);
    expect([401, 403]).toContain(res.status);
  });

  it("accept executes the staged action and marks it accepted", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "accepted", executionOutcome: "completed" });
    expect(mergePullRequest).toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("accepted");
  });

  it("reject cancels the staged action without executing", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "rejected" });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
  });

  it("rejects an invalid decision verb with 400", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/maybe`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(400);
  });

  it("404s an unknown id or another repo's action (no cross-repo decisions)", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const unknown = await app.request("/v1/repos/owner/repo/agent/pending-actions/nope/accept", { method: "POST", headers: headers(env) }, env);
    expect(unknown.status).toBe(404);
    // the action belongs to owner/repo; decided via a different repo path → 404
    const crossRepo = await app.request(`/v1/repos/other/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(crossRepo.status).toBe(404);
  });

  it("a non-operator session is forbidden from the queue", async () => {
    const env = createTestEnv();
    await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "rando", id: 555 });
    const list = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(list.status);
    const decide = await app.request("/v1/repos/owner/repo/agent/pending-actions/x/accept", { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(decide.status);
  });

  it("an operator session decides under its own identity", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "rejected", action: { decidedBy: "jsonbored" } });
  });

  it("a second decision returns 409 already_decided", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: headers(env) }, env);
    const again = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(again.status).toBe(409);
  });

  it("allows a repository owner session to list the approval queue", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 1 });

    const list = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: { cookie: `gittensory_session=${token}` } }, env);

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ repoFullName: "owner/repo", pendingActions: [{ actionClass: "merge", status: "pending" }] });
  });

  it("forbids a contributor (non-maintainer) session even though the coarse allowlist permits the path", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "contributor", id: 999 });

    const list = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(list.status);

    const decide = await app.request("/v1/repos/owner/repo/agent/pending-actions/x/reject", { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(decide.status);
  });
});

describe("agent audit-feed route (#784)", () => {
  async function seedAudit(env: Env) {
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "gittensory", targetKey: "owner/repo#7", outcome: "completed", detail: "merged", createdAt: "2026-06-18T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.pending_action.rejected", actor: "owner", targetKey: "owner/repo#8", outcome: "completed", detail: "rejected merge", createdAt: "2026-06-18T11:00:00.000Z" });
    // excluded: a non-agent event on this repo, and an agent event on a different repo.
    await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", actor: "x", targetKey: "owner/repo#9", outcome: "completed", createdAt: "2026-06-18T12:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "gittensory", targetKey: "other/repo#1", outcome: "completed", createdAt: "2026-06-18T13:00:00.000Z" });
  }

  it("returns this repo's agent action + decision events newest-first, excluding non-agent and other-repo events", async () => {
    const env = createTestEnv();
    await seedAudit(env);
    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: headers(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoFullName: string; events: Array<{ eventType: string; pullNumber: number | null; outcome: string }> };
    expect(body.repoFullName).toBe("owner/repo");
    expect(body.events.map((event) => event.eventType)).toEqual(["agent.pending_action.rejected", "agent.action.merge"]);
    expect(body.events[0]).toMatchObject({ pullNumber: 8, outcome: "completed" });
  });

  it("honors the since filter and the limit", async () => {
    const env = createTestEnv();
    await seedAudit(env);
    const since = await app.request("/v1/repos/owner/repo/agent/audit-feed?since=2026-06-18T10:30:00.000Z", { headers: headers(env) }, env);
    expect(((await since.json()) as { events: unknown[] }).events).toHaveLength(1); // only the 11:00 reject
    const limited = await app.request("/v1/repos/owner/repo/agent/audit-feed?limit=1", { headers: headers(env) }, env);
    expect(((await limited.json()) as { events: unknown[] }).events).toHaveLength(1);
  });

  it("requires authentication and forbids a non-operator session", async () => {
    const env = createTestEnv();
    await seedAudit(env);
    const noauth = await app.request("/v1/repos/owner/repo/agent/audit-feed", {}, env);
    expect([401, 403]).toContain(noauth.status);
    const { token } = await createSessionForGitHubUser(env, { login: "rando", id: 555 });
    const forbidden = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(forbidden.status);
  });

  it("allows a repository owner session to read the audit feed", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedAudit(env);
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 1 });

    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: { authorization: `Bearer ${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ repoFullName: "owner/repo", events: [{ eventType: "agent.pending_action.rejected" }, { eventType: "agent.action.merge" }] });
  });

  it("forbids a contributor (non-maintainer) session even though the coarse allowlist permits the path (#943)", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedAudit(env);
    // A plain contributor — not the repo owner/maintainer/operator. The audit-feed path now clears the
    // coarse session allowlist (#943), so the repo is fully seeded and the ONLY thing that can block is the
    // route's requireRepoMaintainer guard — which must still 403 them, proving the feed is never exposed.
    const { token } = await createSessionForGitHubUser(env, { login: "contributor", id: 999 });

    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: { authorization: `Bearer ${token}` } }, env);

    expect([401, 403]).toContain(res.status);
  });

  it("reports a null pullNumber for an agent event whose targetKey has no numeric PR", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "gittensory", targetKey: "owner/repo#manual", outcome: "completed", createdAt: "2026-06-18T09:00:00.000Z" });
    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: headers(env) }, env);
    const body = (await res.json()) as { events: Array<{ pullNumber: number | null }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.pullNumber).toBeNull();
  });

  it("rejects a malformed since with 400", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed?since=not-a-date", { headers: headers(env) }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_since" });
  });

  it("rejects an out-of-range or non-integer limit with 400", async () => {
    const env = createTestEnv();
    for (const bad of ["0", "201", "abc", "1.5"]) {
      const res = await app.request(`/v1/repos/owner/repo/agent/audit-feed?limit=${bad}`, { headers: headers(env) }, env);
      expect(res.status, `limit=${bad}`).toBe(400);
    }
  });

  it("scrubs forbidden terms from the free-form detail before returning", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "gittensory", targetKey: "owner/repo#7", outcome: "completed", detail: "reward estimate leaked", createdAt: "2026-06-18T10:00:00.000Z" });
    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: headers(env) }, env);
    const body = (await res.json()) as { events: Array<{ detail: string | null }> };
    expect(body.events[0]?.detail).not.toMatch(/reward/i);
    expect(body.events[0]?.detail).toContain("private context");
  });
});
