import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { listNotificationDeliveriesForRecipient } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// Operator API token (same posture as routes-notifications.test.ts) — requireContributorAccess allows the
// static `api` identity to post AMS events for any login; session callers need ADMIN_GITHUB_LOGINS first.
const jsonHeaders = (env: Env) => ({
  authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
  "content-type": "application/json",
});

describe("POST /v1/contributors/:login/ams-notifications (#7657)", () => {
  it("evaluates AMS events through the existing notify-deliver path", async () => {
    const sent: Array<{ type: string; deliveryId?: string; requestedBy?: string }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: { type: string; deliveryId?: string; requestedBy?: string }) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const app = createApp();

    const response = await app.request(
      "/v1/contributors/miner/ams-notifications",
      {
        method: "POST",
        headers: jsonHeaders(env),
        body: JSON.stringify({
          events: [
            {
              eventType: "ams_attempt_started",
              repoFullName: "acme/widgets",
              pullNumber: 3,
              dedupKey: "ams_attempt_started:acme/widgets#3:a1",
              deeplink: "https://github.com/acme/widgets/issues/3",
              actorLogin: "miner",
              detectedAt: "2026-07-21T00:00:00.000Z",
            },
          ],
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: number; enqueued: number; login: string };
    expect(body).toEqual({ login: "miner", accepted: 1, enqueued: 1 });
    expect(sent).toEqual([{ type: "notify-deliver", requestedBy: "notify-evaluate", deliveryId: expect.any(String) }]);

    const deliveries = await listNotificationDeliveriesForRecipient(env, "miner", { eventType: "ams_attempt_started" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ eventType: "ams_attempt_started", pullNumber: 3, status: "pending" });
  });

  it("rejects forged webhook event kinds and invalid bodies", async () => {
    const env = createTestEnv();
    const app = createApp();

    const forged = await app.request(
      "/v1/contributors/miner/ams-notifications",
      {
        method: "POST",
        headers: jsonHeaders(env),
        body: JSON.stringify({
          events: [
            {
              eventType: "pull_request_merged",
              repoFullName: "acme/widgets",
              pullNumber: 1,
              dedupKey: "x",
              deeplink: "https://example.com",
              actorLogin: "miner",
              detectedAt: "2026-07-21T00:00:00.000Z",
            },
          ],
        }),
      },
      env,
    );
    expect(forged.status).toBe(400);

    const empty = await app.request(
      "/v1/contributors/miner/ams-notifications",
      {
        method: "POST",
        headers: jsonHeaders(env),
        body: JSON.stringify({ events: [] }),
      },
      env,
    );
    expect(empty.status).toBe(400);
  });

  it("rejects an unauthenticated request and a malformed JSON body", async () => {
    const env = createTestEnv();
    const app = createApp();

    const unauthenticated = await app.request(
      "/v1/contributors/miner/ams-notifications",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [] }) },
      env,
    );
    expect(unauthenticated.status).toBeGreaterThanOrEqual(401);

    const malformed = await app.request(
      "/v1/contributors/miner/ams-notifications",
      { method: "POST", headers: jsonHeaders(env), body: "not-json" },
      env,
    );
    expect(malformed.status).toBe(400);
  });
});
