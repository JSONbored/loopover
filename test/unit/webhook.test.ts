import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { handleGitHubWebhook } from "../../src/github/webhook";
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
