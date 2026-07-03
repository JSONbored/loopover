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
import { buildBrief } from "./brief.js";
import {
  parseEnrichRequestBody,
  readEnrichRequestText,
} from "./request-guardrails.js";
import {
  captureRouteError,
  captureUnhandledError,
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
  captureRouteError(error, { method: c.req.method, route: c.req.path });
  return c.json({ error: "internal_error" }, 500);
});

// Lightweight auth-check endpoint the engine calls at startup to surface secret mismatches
// before any review runs. No analysis is performed; the response is always {ok:true} on success.
app.post("/v1/ping", (c) => {
  const secret = normalizeSharedSecret(process.env.REES_SHARED_SECRET);
  if (!secret) return c.json({ error: "service_not_configured" }, 503);
  if (!verifyBearer(c.req.header("authorization"), secret))
    return c.json({ error: "unauthorized" }, 401);
  return c.json({ ok: true });
});

app.post("/v1/enrich", async (c) => {
  const secret = normalizeSharedSecret(process.env.REES_SHARED_SECRET);
  // No secret configured ⇒ the service is not ready to authenticate anything; fail closed.
  if (!secret) return c.json({ error: "service_not_configured" }, 503);
  if (!verifyBearer(c.req.header("authorization"), secret))
    return c.json({ error: "unauthorized" }, 401);

  const body = await readEnrichRequestText(c.req.raw);
  if (!body.ok) return c.json({ error: body.error }, body.status);

  const parsed = parseEnrichRequestBody(body.raw);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const brief = await buildBrief(parsed.payload, undefined, {
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
  captureUnhandledError(reason, { event: "rees_unhandled_rejection" });
});

process.on("uncaughtException", (error) => {
  captureUnhandledError(error, { event: "rees_uncaught_exception" });
  void flushSentry().finally(() => process.exit(1));
});

process.on("SIGTERM", () => {
  void flushSentry().finally(() => process.exit(0));
});

export { app };
