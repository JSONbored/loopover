import { beforeEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import { enqueueWebhookByEnv, handleGitHubWebhook, handleOrbRelay } from "../../src/github/webhook";
import { getWebhookEvent, recordWebhookEvent } from "../../src/db/repositories";
import { relaySignature } from "../../src/orb/relay";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import {
  clearSelfHostRequestTraceParent,
  setSelfHostRequestTraceParent,
} from "../../src/selfhost/trace-context";
import { createTestEnv } from "../helpers/d1";

beforeEach(() => {
  resetMetrics();
});

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
  it("flags the event 'error' when the WEBHOOKS binding is missing", async () => {
    const env = createTestEnv();
    delete env.WEBHOOKS;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "enqueue-missing-binding-1",
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
    const event = await getWebhookEvent(env, "enqueue-missing-binding-1");
    expect(event?.status).toBe("error");
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="opened",event="pull_request",result="enqueue_failed"} 1');
  });

  it("flags the event 'error' and returns 500 when the queue send fails", async () => {
    const env = createTestEnv();
    env.WEBHOOKS = {
      send: async () => {
        throw new Error("queue unavailable");
      },
    } as unknown as Queue;
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
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="opened",event="pull_request",result="enqueue_failed"} 1');
  });
});

describe("github webhook dedup (#789)", () => {
  it("suppresses redelivery of an already-processed event instead of re-running side effects", async () => {
    const env = createTestEnv();
    let sendCount = 0;
    env.WEBHOOKS = {
      send: async () => {
        sendCount += 1;
      },
    } as unknown as Queue;
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
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="opened",event="pull_request",result="duplicate"} 1');
  });
});

describe("github webhook queue isolation (#audit-webhook-queue)", () => {
  it("records bounded enqueue metrics for invalid JSON and unknown event/action values", async () => {
    const env = createTestEnv();
    env.WEBHOOKS = { send: async () => undefined } as unknown as Queue;

    await expect(enqueueWebhookByEnv(env, "invalid-json-metric", "pull_request", "{")).resolves.toBe("invalid_json");
    await expect(
      enqueueWebhookByEnv(
        env,
        "unknown-event-metric",
        "workflow_job",
        JSON.stringify({
          action: "synchronize_again",
          repository: { full_name: "JSONbored/gittensory" },
          installation: { id: 1 },
        }),
      ),
    ).resolves.toBe("queued");

    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_webhook_enqueue_total{action="none",event="pull_request",result="invalid_json"} 1');
    expect(metrics).toContain('gittensory_webhook_enqueue_total{action="other",event="other",result="queued"} 1');
  });

  it("rejects retired direct review-app webhooks when the self-host review runtime is absent", async () => {
    const env = createTestEnv();
    delete env.SELFHOST_TRANSIENT_CACHE;
    let webhookSends = 0;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "broker-only-webhook-1",
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

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: "selfhost_review_runtime_required" });
    expect(webhookSends).toBe(0);
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="none",event="pull_request",result="review_unavailable"} 1');
  });

  it("INVARIANT: a valid webhook is enqueued onto the dedicated WEBHOOKS lane, never the shared JOBS queue", async () => {
    const env = createTestEnv();
    let jobsSends = 0;
    let webhookSends = 0;
    env.JOBS = { send: async () => void (jobsSends += 1) } as unknown as typeof env.JOBS;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "isolation-1",
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
    await expect(response.json()).resolves.toMatchObject({ status: "queued" });
    expect(webhookSends).toBe(1); // routed to the dedicated webhook lane
    expect(jobsSends).toBe(0); // never the shared maintenance queue
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="opened",event="pull_request",result="queued"} 1');
  });

  it("copies the internal self-host traceparent onto queued webhook jobs", async () => {
    const env = createTestEnv();
    const sent: import("../../src/types").JobMessage[] = [];
    env.WEBHOOKS = { send: async (message: unknown) => void sent.push(message as import("../../src/types").JobMessage) } as unknown as Queue;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const traceParent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    setSelfHostRequestTraceParent(request, traceParent);
    const headers: Record<string, string> = {
      "x-github-delivery": "traceparent-1",
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
    clearSelfHostRequestTraceParent(request);

    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "github-webhook", traceParent });
  });

  it("drops self-authored app comment webhooks before they add queue pressure", async () => {
    const env = createTestEnv();
    let webhookSends = 0;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({
      action: "edited",
      repository: { full_name: "JSONbored/gittensory" },
      installation: { id: 1 },
      issue: { number: 1701, pull_request: {} },
      comment: { id: 123, body: "<!-- gittensory-pr-panel:v1 -->", user: { login: "gittensory[bot]", type: "Bot" } },
      sender: { login: "gittensory[bot]", type: "Bot" },
    });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "self-comment-ignore-1",
      "x-github-event": "issue_comment",
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
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });
    expect(webhookSends).toBe(0);
    const event = await getWebhookEvent(env, "self-comment-ignore-1");
    expect(event?.status).toBe("processed");
    expect(await renderMetrics()).toContain('gittensory_webhook_enqueue_total{action="edited",event="issue_comment",result="ignored"} 1');
  });

  it("drops self-authored app CI completion webhooks before they add queue pressure", async () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory-orb" });
    let webhookSends = 0;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({
      action: "completed",
      repository: { full_name: "JSONbored/gittensory" },
      installation: { id: 1 },
      check_suite: {
        head_sha: "abc123",
        pull_requests: [],
        app: { slug: "gittensory-orb" },
      },
    });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "self-check-suite-ignore-1",
      "x-github-event": "check_suite",
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
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });
    expect(webhookSends).toBe(0);
    const event = await getWebhookEvent(env, "self-check-suite-ignore-1");
    expect(event?.status).toBe("processed");
  });

  it("drops non-completed CI lifecycle webhooks before they add queue pressure", async () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory-orb" });
    let webhookSends = 0;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({
      action: "requested",
      repository: { full_name: "JSONbored/gittensory" },
      installation: { id: 1 },
      check_suite: {
        head_sha: "abc123",
        pull_requests: [{ number: 1832 }],
        app: { slug: "github-actions" },
      },
    });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "requested-check-suite-ignore-1",
      "x-github-event": "check_suite",
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
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });
    expect(webhookSends).toBe(0);
    const event = await getWebhookEvent(env, "requested-check-suite-ignore-1");
    expect(event?.status).toBe("processed");
  });

  it("keeps third-party CI completion webhooks queued for review finalization", async () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory-orb" });
    const sent: unknown[] = [];
    env.WEBHOOKS = { send: async (message: unknown) => void sent.push(message) } as unknown as Queue;
    const rawBody = JSON.stringify({
      action: "completed",
      repository: { full_name: "JSONbored/gittensory" },
      installation: { id: 1 },
      check_suite: {
        head_sha: "abc123",
        pull_requests: [{ number: 1832 }],
        app: { slug: "github-actions" },
      },
    });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "third-party-check-suite-queue-1",
      "x-github-event": "check_suite",
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
    await expect(response.json()).resolves.toMatchObject({ status: "queued" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "github-webhook", eventName: "check_suite" });
    const event = await getWebhookEvent(env, "third-party-check-suite-queue-1");
    expect(event?.status).toBe("queued");
  });

  it("drops bot-authored issue comment edits but keeps them auditable", async () => {
    const env = createTestEnv();
    let webhookSends = 0;
    env.WEBHOOKS = { send: async () => void (webhookSends += 1) } as unknown as Queue;
    const rawBody = JSON.stringify({
      action: "edited",
      repository: { full_name: "JSONbored/gittensory" },
      installation: { id: 1 },
      issue: { number: 1701, pull_request: {} },
      comment: { id: 123, body: "coverage updated", user: { login: "codecov[bot]", type: "User" } },
      sender: { login: "codecov[bot]", type: "User" },
    });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "bot-comment-edit-ignore-1",
      "x-github-event": "issue_comment",
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
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });
    expect(webhookSends).toBe(0);
    const event = await getWebhookEvent(env, "bot-comment-edit-ignore-1");
    expect(event?.status).toBe("processed");
  });
});

describe("handleOrbRelay (brokered self-host relay receiver)", () => {
  const makeRelayContext = (
    env: Env,
    body: string,
    headers: Record<string, string | undefined>,
    bodyStream?: ReadableStream<Uint8Array>,
  ): Context<{ Bindings: Env }> => {
    const request = new Request("https://example.com/v1/orb/relay", {
      method: "POST",
      body: bodyStream ?? body,
    });
    return {
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
  };

  it("returns 400 when required GitHub headers are missing", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbenr_testsecret" });
    // missing delivery
    let ctx = makeRelayContext(env, "{}", { "x-github-event": "pull_request" });
    expect((await handleOrbRelay(ctx)).status).toBe(400);
    // missing event
    ctx = makeRelayContext(env, "{}", { "x-github-delivery": "d1" });
    expect((await handleOrbRelay(ctx)).status).toBe(400);
  });

  it("returns 404 when ORB_ENROLLMENT_SECRET is not set (not a brokered self-host)", async () => {
    const env = createTestEnv(); // no ORB_ENROLLMENT_SECRET in the base test env
    const ctx = makeRelayContext(env, "{}", {
      "x-github-delivery": "d1",
      "x-github-event": "pull_request",
      "x-orb-signature-256": "sha256=badbad",
    });
    const resp = await handleOrbRelay(ctx);
    expect(resp.status).toBe(404);
    await expect(resp.json()).resolves.toMatchObject({ error: "relay_not_configured" });
  });

  it("returns 401 when the HMAC signature is wrong", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbenr_testsecret" });
    const ctx = makeRelayContext(env, '{"action":"opened"}', {
      "x-github-delivery": "d2",
      "x-github-event": "pull_request",
      "x-orb-signature-256": "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
    });
    const resp = await handleOrbRelay(ctx);
    expect(resp.status).toBe(401);
    await expect(resp.json()).resolves.toMatchObject({ error: "invalid_signature" });
  });

  it("returns 500 (enqueue_failed) and flips event to 'error' when WEBHOOKS.send throws", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbenr_testsecret" });
    env.WEBHOOKS = { send: async () => { throw new Error("queue down"); } } as unknown as Queue;
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/widgets" }, installation: { id: 99 } });
    const sig = `sha256=${await relaySignature("orbenr_testsecret", body)}`;
    const ctx = makeRelayContext(env, body, { "x-github-delivery": "relay-fail-1", "x-github-event": "pull_request", "x-orb-signature-256": sig });
    const resp = await handleOrbRelay(ctx);
    expect(resp.status).toBe(500);
    await expect(resp.json()).resolves.toMatchObject({ error: "enqueue_failed", deliveryId: "relay-fail-1" });
  });

  it("returns 202 queued when signature is valid and WEBHOOKS.send succeeds", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbenr_testsecret" });
    let sent = 0;
    env.WEBHOOKS = { send: async () => void (sent += 1) } as unknown as Queue;
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/widgets" }, installation: { id: 99 } });
    const sig = `sha256=${await relaySignature("orbenr_testsecret", body)}`;
    const ctx = makeRelayContext(env, body, { "x-github-delivery": "relay-ok-1", "x-github-event": "pull_request", "x-orb-signature-256": sig });
    const resp = await handleOrbRelay(ctx);
    expect(resp.status).toBe(202);
    await expect(resp.json()).resolves.toMatchObject({ ok: true, status: "queued", deliveryId: "relay-ok-1" });
    expect(sent).toBe(1); // routed to the WEBHOOKS queue
  });
});

async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
