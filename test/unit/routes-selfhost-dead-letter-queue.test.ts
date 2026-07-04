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
} = {}): Queue {
  return {
    async send() {},
    async sendBatch() {},
    listDeadLetterJobs: overrides.listDeadLetterJobs ?? (() => []),
    deadCount: overrides.deadCount ?? (() => 0),
  } as unknown as Queue;
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
