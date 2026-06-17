import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { handleGitHubWebhook } from "../../src/github/webhook";
import { getWebhookEvent, recordWebhookEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("github webhook body reader edge cases", () => {
  it("skips undefined stream chunks and still rejects invalid signatures", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(undefined as unknown as Uint8Array);
        controller.close();
      },
    });
    const request = { body } as unknown as Request;
    const env = createTestEnv();
    const headers: Record<string, string> = {
      "x-github-delivery": "stream-edge-case",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=bad",
    };
    const context = {
      req: {
        raw: request,
        header(name: string) {
          return headers[name.toLowerCase()] ?? null;
        },
      },
      env,
      json(payload: unknown, status?: number) {
        return Response.json(payload, status === undefined ? undefined : { status });
      },
    } as unknown as Context<{ Bindings: Env }>;

    const response = await handleGitHubWebhook(context);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_signature" });
  });
});

describe("github webhook enqueue failure (#786)", () => {
  it("flags the event 'error' and returns 500 when the queue send fails", async () => {
    const env = createTestEnv();
    env.JOBS = {
      send: async () => {
        throw new Error("queue unavailable");
      },
    } as unknown as typeof env.JOBS;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "enqueue-fail-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    };
    const context = {
      req: {
        raw: request,
        header(name: string) {
          return headers[name.toLowerCase()] ?? null;
        },
      },
      env,
      json(payload: unknown, status?: number) {
        return Response.json(payload, status === undefined ? undefined : { status });
      },
    } as unknown as Context<{ Bindings: Env }>;

    const response = await handleGitHubWebhook(context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "enqueue_failed" });
    // Flagged "error" so the dedup guard lets GitHub redeliver instead of suppressing it.
    const event = await getWebhookEvent(env, "enqueue-fail-1");
    expect(event?.status).toBe("error");
  });
});

describe("github webhook dedup (#789)", () => {
  it("suppresses redelivery of an already-processed event instead of re-running side effects", async () => {
    const env = createTestEnv();
    let sendCount = 0;
    env.JOBS = {
      send: async () => {
        sendCount += 1;
      },
    } as unknown as typeof env.JOBS;
    // Seed a fully-processed event: on success the queue overwrites payloadHash with the "processed"
    // sentinel, so a redelivery carries the real hash and a hash-only dedup would miss it.
    await recordWebhookEvent(env, { deliveryId: "redelivery-1", eventName: "pull_request", payloadHash: "processed", status: "processed" });
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "redelivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    };
    const context = {
      req: {
        raw: request,
        header(name: string) {
          return headers[name.toLowerCase()] ?? null;
        },
      },
      env,
      json(payload: unknown, status?: number) {
        return Response.json(payload, status === undefined ? undefined : { status });
      },
    } as unknown as Context<{ Bindings: Env }>;

    const response = await handleGitHubWebhook(context);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "duplicate" });
    expect(sendCount).toBe(0); // not re-enqueued
  });
});

async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
