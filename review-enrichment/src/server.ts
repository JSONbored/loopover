// Gittensory review-enrichment service (REES).
//
// Given a PR (repo, number, headSha, diff, files, short-lived token), this service runs the heavy/external/
// historical analysis the no-checkout `claude --print` reviewer is blind to, and returns a pre-rendered,
// public-safe "review brief" the engine splices into the prompt next to grounding + RAG. The engine treats any
// timeout/error as "no brief" and proceeds — so this service is strictly additive and fully fail-safe.
//
// Transport + contract here; the analysis lives in brief.ts (orchestrator) + analyzers/* — dependency/CVE (#1474),
// then license (#1475), secret (#1476), static+complexity (#1477), history (#1478), each filling one findings key.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { verifyBearer } from "./auth.js";
import type { EnrichRequest } from "./types.js";
import { buildBrief } from "./brief.js";

const app = new Hono();

app.get("/health", (c) =>
  c.json({ status: "ok", service: "review-enrichment" }),
);
app.get("/ready", (c) => c.json({ ready: true }));

app.post("/v1/enrich", async (c) => {
  const secret = process.env.REES_SHARED_SECRET;
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

  const brief = await buildBrief(payload);
  return c.json(brief);
});

const port = Number(process.env.PORT ?? "8080");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ event: "rees_listening", port: info.port }));
});

export { app };
