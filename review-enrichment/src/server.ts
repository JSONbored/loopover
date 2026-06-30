// Gittensory review-enrichment service (REES).
//
// Given a PR (repo, number, headSha, diff, files, optional GitHub token), this service runs the
// heavy/external analysis the no-checkout reviewer is blind to, and returns a pre-rendered, public-safe
// "review brief" the engine splices into the prompt next to grounding + RAG. The engine treats any
// timeout/error as "no brief" and proceeds, so this service is strictly additive and fail-safe.
//
// Transport + contract here; the analysis lives in brief.ts (orchestrator) + analyzers/*, with each analyzer
// filling one findings key for renderer/prompt consumption.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { normalizeSharedSecret, verifyBearer } from "./auth.js";
import type { EnrichRequest } from "./types.js";
import { buildBrief } from "./brief.js";
import {
  captureError,
  flushSentry,
  initSentry,
  resolveSentryEnvironment,
} from "./sentry.js";

const app = new Hono();
const sentryEnabled = await initSentry(process.env);
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

function traceIdFromTraceparent(value: string | undefined): string | undefined {
  const match = value?.trim().match(TRACEPARENT_RE);
  return match?.[1]?.toLowerCase();
}

if (sentryEnabled) {
  console.log(
    JSON.stringify({
      event: "rees_sentry",
      environment: resolveSentryEnvironment(process.env),
    }),
  );
}

app.get("/health", (c) =>
  c.json({ status: "ok", service: "review-enrichment" }),
);
app.get("/ready", (c) => c.json({ ready: true }));

app.onError((error, c) => {
  captureError(error, { method: c.req.method, path: c.req.path });
  return c.json({ error: "internal_error" }, 500);
});

app.post("/v1/enrich", async (c) => {
  const secret = normalizeSharedSecret(process.env.REES_SHARED_SECRET);
  // No secret configured ⇒ the service is not ready to authenticate anything; fail closed.
  if (!secret) return c.json({ error: "service_not_configured" }, 503);
  if (!verifyBearer(c.req.header("authorization"), secret))
    return c.json({ error: "unauthorized" }, 401);

  const payload = (await c.req
    .json()
    .catch(() => null)) as EnrichRequest | null;
  if (
    !payload ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.prNumber !== "number"
  ) {
    return c.json({ error: "bad_request" }, 400);
  }

  const brief = await buildBrief(payload, undefined, {
    requestId: c.req.header("x-gittensory-request-id") ?? c.req.header("x-request-id"),
    traceId: traceIdFromTraceparent(c.req.header("traceparent")),
  });
  return c.json(brief);
});

const port = Number(process.env.PORT ?? "8080");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ event: "rees_listening", port: info.port }));
});

process.on("unhandledRejection", (reason) => {
  captureError(reason, { event: "unhandled_rejection" });
});

process.on("uncaughtException", (error) => {
  captureError(error, { event: "uncaught_exception" });
  void flushSentry().finally(() => process.exit(1));
});

process.on("SIGTERM", () => {
  void flushSentry().finally(() => process.exit(0));
});

export { app };
