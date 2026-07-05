import { describe, expect, it } from "vitest";

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #2214: the read-only dead-letter-queue table view. The self-host queue backend's admin surface is mirrored
// onto env.JOBS (see queueDeadLetterPageFromBinding) rather than a new Env field, so a plain Cloudflare-shaped
// JOBS stub (createTestEnv()'s default) exercises the "admin unavailable" 501 path, and an override JOBS with
// listDeadLetterJobs/deadCount exercises the populated self-host path.

function selfhostJobsStub(overrides: {
  listDeadLetterJobs?: (limit: number, offset: number) => unknown[];
  deadCount?: () => number;
  replayDeadLetterJob?: (id: number) => boolean;
  deleteDeadLetterJob?: (id: number) => boolean;
  purgeDeadLetterJobs?: () => number;
} = {}): Queue {
  return {
    async send() {},
    async sendBatch() {},
    listDeadLetterJobs: overrides.listDeadLetterJobs ?? (() => []),
    deadCount: overrides.deadCount ?? (() => 0),
    replayDeadLetterJob: overrides.replayDeadLetterJob ?? (() => true),
    deleteDeadLetterJob: overrides.deleteDeadLetterJob ?? (() => true),
    purgeDeadLetterJobs: overrides.purgeDeadLetterJobs ?? (() => 0),
  } as unknown as Queue;
}

async function auditRows(env: Env, eventType: string): Promise<Array<{ actor: string; outcome: string; metadata_json: string }>> {
  const result = (await env.DB.prepare(
    "select actor, outcome, metadata_json from audit_events where event_type = ? order by created_at desc",
  )
    .bind(eventType)
    .all()) as { results: Array<{ actor: string; outcome: string; metadata_json: string }> };
  return result.results;
}

describe("dead-letter-queue table route (#2214)", () => {
  it("is unauthorized with no identity at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/selfhost/queue/dead", {}, env);
    expect(res.status).toBe(401);
  });

  it("is forbidden for an authenticated session without the operator role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const res = await app.request("/v1/app/selfhost/queue/dead", { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(403);
  });

  it("returns 501 (not a false empty page) when the queue backend has no dead-letter admin surface", async () => {
    const app = createApp();
    const env = createTestEnv(); // default JOBS stub is Cloudflare-shaped: no listDeadLetterJobs/deadCount
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request("/v1/app/selfhost/queue/dead", { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_admin_unavailable" });
  });

  it("returns a populated page for an operator session against a self-host-shaped JOBS binding", async () => {
    const app = createApp();
    const items = [
      { id: 2, jobType: "github-webhook", attempts: 1, lastError: "kaboom", createdAtMs: 2000, deadAtMs: 9000 },
      { id: 1, jobType: "agent-regate-pr", attempts: 3, lastError: "boom", createdAtMs: 1000, deadAtMs: 5000 },
    ];
    const env = createTestEnv({ JOBS: selfhostJobsStub({ listDeadLetterJobs: () => items, deadCount: () => 2 }) });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request("/v1/app/selfhost/queue/dead", { headers: { cookie: `gittensory_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ limit: 25, offset: 0, total: 2, items });
  });

  it("returns an empty items array (not 501) when the admin surface reports a genuinely empty DLQ", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub() });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request("/v1/app/selfhost/queue/dead", { headers: { cookie: `gittensory_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("clamps limit/offset query params before they reach the queue backend", async () => {
    const app = createApp();
    let seenLimit = -1;
    let seenOffset = -1;
    const env = createTestEnv({
      JOBS: selfhostJobsStub({
        listDeadLetterJobs: (limit, offset) => {
          seenLimit = limit;
          seenOffset = offset;
          return [];
        },
      }),
    });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead?limit=500&offset=-5",
      { headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seenLimit).toBe(100); // clampInteger ceiling
    expect(seenOffset).toBe(0); // Math.max(0, ...) floor
  });

  it("rejects an invalid query instead of silently coercing it", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub() });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead?limit=not-a-number",
      { headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_query" });
  });
});

// #2215: the admin action trio built on top of the #2214 read-only view -- replay/delete a single dead job,
// or purge all of them. Same env.JOBS-binding mirror and null/501 "admin unavailable" contract.

describe("dead-letter-queue replay route (#2215)", () => {
  it("is unauthorized with no identity at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/selfhost/queue/dead/1/replay", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("is forbidden for an authenticated session without the operator role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/1/replay",
      { method: "POST", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it.each(["abc", "-1", "0", "1.5"])("rejects an invalid job id %s", async (badId) => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub() });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      `/v1/app/selfhost/queue/dead/${badId}/replay`,
      { method: "POST", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_job_id" });
  });

  it("returns 501 when the queue backend has no dead-letter admin surface", async () => {
    const app = createApp();
    const env = createTestEnv(); // default JOBS stub is Cloudflare-shaped: no replayDeadLetterJob
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/1/replay",
      { method: "POST", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_admin_unavailable" });
  });

  it("returns 404 when the job isn't found or isn't currently dead", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub({ replayDeadLetterJob: () => false }) });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/99/replay",
      { method: "POST", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_job_not_found" });
  });

  it("replays the job for an operator session and audits it", async () => {
    const app = createApp();
    let seenId = -1;
    const env = createTestEnv({
      JOBS: selfhostJobsStub({
        replayDeadLetterJob: (id) => {
          seenId = id;
          return true;
        },
      }),
    });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead/7/replay",
      { method: "POST", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, id: 7 });
    expect(seenId).toBe(7);

    const audits = await auditRows(env, "operator.dlq_job_replayed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "jsonbored", outcome: "completed" });
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({ id: 7 });
  });
});

describe("dead-letter-queue delete route (#2215)", () => {
  it("is unauthorized with no identity at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/selfhost/queue/dead/1", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("is forbidden for an authenticated session without the operator role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/1",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it.each(["abc", "-1", "0", "1.5"])("rejects an invalid job id %s", async (badId) => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub() });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      `/v1/app/selfhost/queue/dead/${badId}`,
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_job_id" });
  });

  it("returns 501 when the queue backend has no dead-letter admin surface", async () => {
    const app = createApp();
    const env = createTestEnv(); // default JOBS stub is Cloudflare-shaped: no deleteDeadLetterJob
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/1",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_admin_unavailable" });
  });

  it("returns 404 when the job isn't found or isn't currently dead", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub({ deleteDeadLetterJob: () => false }) });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead/99",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_job_not_found" });
  });

  it("deletes the job for an operator session and audits it", async () => {
    const app = createApp();
    let seenId = -1;
    const env = createTestEnv({
      JOBS: selfhostJobsStub({
        deleteDeadLetterJob: (id) => {
          seenId = id;
          return true;
        },
      }),
    });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead/7",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, id: 7 });
    expect(seenId).toBe(7);

    const audits = await auditRows(env, "operator.dlq_job_deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "jsonbored", outcome: "completed" });
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({ id: 7 });
  });
});

describe("dead-letter-queue purge route (#2215)", () => {
  it("is unauthorized with no identity at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/selfhost/queue/dead", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("is forbidden for an authenticated session without the operator role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 501 when the queue backend has no dead-letter admin surface", async () => {
    const app = createApp();
    const env = createTestEnv(); // default JOBS stub is Cloudflare-shaped: no purgeDeadLetterJobs
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/selfhost/queue/dead",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({ error: "dead_letter_admin_unavailable" });
  });

  it("purges all dead-letter jobs for an operator session and audits it", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub({ purgeDeadLetterJobs: () => 3 }) });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, purged: 3 });

    const audits = await auditRows(env, "operator.dlq_purged");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "jsonbored", outcome: "completed" });
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({ purged: 3 });
  });

  it("purges zero dead-letter jobs without error when the DLQ is already empty", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: selfhostJobsStub({ purgeDeadLetterJobs: () => 0 }) });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });

    const res = await app.request(
      "/v1/app/selfhost/queue/dead",
      { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, purged: 0 });
  });
});
