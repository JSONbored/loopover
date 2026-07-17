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
      liveLabels: [] as string[],
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
    fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], advisoryHoldDetails: [], ciCompletenessWarning: null })),
  };
});

import { mergePullRequest } from "../../src/github/pr-actions";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createApp } from "../../src/api/routes";
import { createPendingAgentActionIfAbsent, getPendingAgentAction, recordAuditEvent, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const app = createApp();
const headers = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

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

    const list = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ repoFullName: "owner/repo", pendingActions: [{ actionClass: "merge", status: "pending" }] });
  });

  it("forbids repository owner browser sessions from deciding pending actions", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const action = await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 1 });

    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: { cookie: `loopover_session=${token}`, origin: "https://preview.example" } }, env);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "insufficient_role" });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("pending");
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

describe("agent propose route (#6744) — POST create side of the approval queue", () => {
  // Seed the repo + installation (and optionally a PR) WITHOUT staging an action — the route is what creates it.
  async function seedRepo(env: Env, pr?: { number: number; headSha: string }) {
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    // upsertInstallation registers the installation; the repo row's own installationId is set by this call — the
    // route's `repo?.installationId` check (mirroring proposeAction) reads that column.
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    if (pr) await upsertPullRequestFromGitHub(env, "owner/repo", { number: pr.number, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: pr.headSha }, labels: [], body: "x" });
  }
  const post = (env: Env, body: unknown) => app.request("/v1/repos/owner/repo/agent/pending-actions", { method: "POST", headers: headers(env), body: JSON.stringify(body) }, env);

  it("stages a minimal action, pinning the PR head SHA and defaulting the rest (parity with the MCP tool's data.action)", async () => {
    const env = createTestEnv();
    await seedRepo(env, { number: 7, headSha: "h7" });
    const res = await post(env, { pullNumber: 7, actionClass: "review" });
    expect(res.status).toBe(200);
    // The route returns EXACTLY the { created, action:{ id, actionClass, pullNumber, status, reason } } shape the
    // loopover_propose_action MCP tool returns in data — no extra/missing fields.
    const json = (await res.json()) as { created: boolean; action: { id: string; actionClass: string; pullNumber: number; status: string; reason: string | null } };
    expect(json.created).toBe(true);
    expect(json.action).toEqual({ id: expect.any(String), actionClass: "review", pullNumber: 7, status: "pending", reason: null });
    // Head-SHA pinned; no optional params carried when none were sent.
    const stored = await getPendingAgentAction(env, json.action.id);
    expect(stored?.params).toEqual({ expectedHeadSha: "h7" });
  });

  it("carries every optional param and omits the head pin when the PR is unknown", async () => {
    const env = createTestEnv();
    await seedRepo(env); // installation only — PR #8 is deliberately not seeded, so there is no head to pin
    const res = await post(env, { pullNumber: 8, actionClass: "merge", reason: "stale base", label: "needs-rebase", reviewBody: "please rebase", mergeMethod: "squash", closeComment: "closing stale" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { created: boolean; action: { id: string; reason: string | null } };
    expect(json.created).toBe(true);
    expect(json.action.reason).toBe("stale base");
    const stored = await getPendingAgentAction(env, json.action.id);
    expect(stored?.params).toEqual({ label: "needs-rebase", reviewBody: "please rebase", mergeMethod: "squash", closeComment: "closing stale" });
  });

  it("is idempotent: a second identical propose returns created:false", async () => {
    const env = createTestEnv();
    await seedRepo(env, { number: 7, headSha: "h7" });
    const first = (await (await post(env, { pullNumber: 7, actionClass: "review" })).json()) as { created: boolean; action: { id: string } };
    expect(first.created).toBe(true);
    const second = (await (await post(env, { pullNumber: 7, actionClass: "review" })).json()) as { created: boolean; action: { id: string } };
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
  });

  it("rejects a schema-invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    await seedRepo(env, { number: 7, headSha: "h7" });
    for (const body of [{ actionClass: "review" }, { pullNumber: 7, actionClass: "bogus" }, { pullNumber: -1, actionClass: "review" }]) {
      const res = await post(env, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_propose_action_request" });
    }
    const malformed = await app.request("/v1/repos/owner/repo/agent/pending-actions", { method: "POST", headers: headers(env), body: "{not json" }, env);
    expect(malformed.status).toBe(400);
  });

  it("409s when the LoopOver App is not installed on the repo", async () => {
    const env = createTestEnv(); // no installation seeded → getRepository has no installationId
    const res = await post(env, { pullNumber: 7, actionClass: "review" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "app_not_installed" });
  });

  it("forbids a non-maintainer session from staging an action", async () => {
    const env = createTestEnv();
    await seedRepo(env, { number: 7, headSha: "h7" });
    const { token } = await createSessionForGitHubUser(env, { login: "rando", id: 555 });
    const res = await app.request("/v1/repos/owner/repo/agent/pending-actions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ pullNumber: 7, actionClass: "review" }) }, env);
    expect([401, 403]).toContain(res.status);
  });
});

describe("agent audit-feed route (#784)", () => {
  async function seedAudit(env: Env) {
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "loopover", targetKey: "owner/repo#7", outcome: "completed", detail: "merged", createdAt: "2026-06-18T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.pending_action.rejected", actor: "owner", targetKey: "owner/repo#8", outcome: "completed", detail: "rejected merge", createdAt: "2026-06-18T11:00:00.000Z" });
    // excluded: a non-agent event on this repo, and an agent event on a different repo.
    await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", actor: "x", targetKey: "owner/repo#9", outcome: "completed", createdAt: "2026-06-18T12:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "loopover", targetKey: "other/repo#1", outcome: "completed", createdAt: "2026-06-18T13:00:00.000Z" });
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
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "loopover", targetKey: "owner/repo#manual", outcome: "completed", createdAt: "2026-06-18T09:00:00.000Z" });
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
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "loopover", targetKey: "owner/repo#7", outcome: "completed", detail: "reward estimate leaked", createdAt: "2026-06-18T10:00:00.000Z" });
    const res = await app.request("/v1/repos/owner/repo/agent/audit-feed", { headers: headers(env) }, env);
    const body = (await res.json()) as { events: Array<{ detail: string | null }> };
    expect(body.events[0]?.detail).not.toMatch(/reward/i);
    expect(body.events[0]?.detail).toContain("private context");
  });

  describe("?pull=N unfiltered target query", () => {
    async function seedUnfilteredAudit(env: Env) {
      // Unlike seedAudit above, none of these are agent.action.%/agent.pending_action.% -- proving the
      // ?pull= branch carries NO eventType restriction (the whole point of listAuditEventsForTarget).
      await recordAuditEvent(env, { eventType: "github_app.type_label_decision", actor: "loopover", targetKey: "owner/repo#7", outcome: "completed", detail: "applied labels: gittensor:bug", createdAt: "2026-06-18T10:00:00.000Z" });
      await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", actor: "x", targetKey: "owner/repo#7", outcome: "completed", detail: "not_official_gittensor_miner", createdAt: "2026-06-18T11:00:00.000Z" });
      // excluded: a different PR on the same repo, and a same-number PR on a different repo.
      await recordAuditEvent(env, { eventType: "github_app.type_label_decision", actor: "loopover", targetKey: "owner/repo#8", outcome: "completed", createdAt: "2026-06-18T12:00:00.000Z" });
      await recordAuditEvent(env, { eventType: "github_app.type_label_decision", actor: "loopover", targetKey: "other/repo#7", outcome: "completed", createdAt: "2026-06-18T13:00:00.000Z" });
    }

    it("returns every event type for the single PR's targetKey, newest-first, excluding other targets", async () => {
      const env = createTestEnv();
      await seedUnfilteredAudit(env);
      const res = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7", { headers: headers(env) }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repoFullName: string; pullNumber: number; events: Array<{ eventType: string; outcome: string }> };
      expect(body.repoFullName).toBe("owner/repo");
      expect(body.pullNumber).toBe(7);
      expect(body.events.map((event) => event.eventType)).toEqual(["github_app.pr_visibility_skipped", "github_app.type_label_decision"]);
    });

    it("honors since and limit on the ?pull= branch", async () => {
      const env = createTestEnv();
      await seedUnfilteredAudit(env);
      const since = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7&since=2026-06-18T10:30:00.000Z", { headers: headers(env) }, env);
      expect(((await since.json()) as { events: unknown[] }).events).toHaveLength(1);
      const limited = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7&limit=1", { headers: headers(env) }, env);
      expect(((await limited.json()) as { events: unknown[] }).events).toHaveLength(1);
    });

    it("rejects a non-positive-integer pull with 400", async () => {
      const env = createTestEnv();
      for (const bad of ["0", "-1", "abc", "1.5"]) {
        const res = await app.request(`/v1/repos/owner/repo/agent/audit-feed?pull=${bad}`, { headers: headers(env) }, env);
        expect(res.status, `pull=${bad}`).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_pull" });
      }
    });

    it("still requires maintainer auth on the ?pull= branch", async () => {
      const env = createTestEnv();
      await seedUnfilteredAudit(env);
      const noauth = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7", {}, env);
      expect([401, 403]).toContain(noauth.status);
      const { token } = await createSessionForGitHubUser(env, { login: "rando", id: 555 });
      const forbidden = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7", { headers: { authorization: `Bearer ${token}` } }, env);
      expect([401, 403]).toContain(forbidden.status);
    });

    it("scrubs forbidden terms from detail on the ?pull= branch too", async () => {
      const env = createTestEnv();
      await recordAuditEvent(env, { eventType: "github_app.type_label_decision", actor: "loopover", targetKey: "owner/repo#7", outcome: "completed", detail: "reward estimate leaked", createdAt: "2026-06-18T10:00:00.000Z" });
      const res = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7", { headers: headers(env) }, env);
      const body = (await res.json()) as { events: Array<{ detail: string | null }> };
      expect(body.events[0]?.detail).not.toMatch(/reward/i);
      expect(body.events[0]?.detail).toContain("private context");
    });

    it("passes through a null detail on the ?pull= branch unchanged (no sanitizer call on a null)", async () => {
      const env = createTestEnv();
      await recordAuditEvent(env, { eventType: "github_app.type_label_decision", actor: "loopover", targetKey: "owner/repo#7", outcome: "completed", detail: null, createdAt: "2026-06-18T10:00:00.000Z" });
      const res = await app.request("/v1/repos/owner/repo/agent/audit-feed?pull=7", { headers: headers(env) }, env);
      const body = (await res.json()) as { events: Array<{ detail: string | null }> };
      expect(body.events[0]?.detail).toBeNull();
    });
  });
});
