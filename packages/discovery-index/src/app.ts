// The Hono app for the discovery-index service, factored out of server.ts (which just wires real
// dependencies and calls @hono/node-server's serve()) so tests can drive it via Hono's own app.request()
// against injected fakes, without starting a real listener or touching the real network — mirrors
// review-enrichment/src/server.ts's route/auth/error-handling shape, split for testability since this
// service (unlike REES) needs real HTTP-level route tests (200/400/401/503 paths), not just unit tests of
// the pieces underneath.
import { Hono } from "hono";
import {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  type AiPolicyVerdict,
  type DiscoveryIndexCandidate,
  normalizeDiscoveryIndexRequest,
} from "@loopover/engine";
import { normalizeSharedSecret, verifyBearer } from "./auth.js";
import type { TtlCache } from "./cache.js";
import { runDiscoveryQuery, type GitHubClientLike } from "./discovery-query.js";
import { incr, observe, renderMetrics } from "./metrics.js";
import { captureRouteError } from "./sentry.js";
import { parseSoftClaimRequest, softClaimKey, type SoftClaimStoreLike } from "./soft-claim.js";

export interface AppDeps {
  github: GitHubClientLike;
  resultCache: TtlCache<DiscoveryIndexCandidate[]>;
  policyCache: TtlCache<AiPolicyVerdict>;
  cacheTtlMs: number;
  softClaimStore: SoftClaimStoreLike;
  /** Whether this service's own GitHub token is configured — surfaced on /ready. */
  githubConfigured: boolean;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  function recordQueryOutcome(status: string, startedAtMs: number): void {
    incr("discovery_index_query_requests_total", { status });
    observe("discovery_index_query_request_duration_seconds", (Date.now() - startedAtMs) / 1000);
  }

  function recordSoftClaimOutcome(status: string, startedAtMs: number): void {
    incr("discovery_index_soft_claim_requests_total", { status });
    observe("discovery_index_soft_claim_request_duration_seconds", (Date.now() - startedAtMs) / 1000);
  }

  app.get("/health", (c) => c.json({ status: "ok", service: "discovery-index" }));
  app.get("/ready", (c) => c.json({ ready: deps.githubConfigured }, deps.githubConfigured ? 200 : 503));
  app.get("/metrics", (c) => c.text(renderMetrics()));

  app.onError((error, c) => {
    // Hono's ErrorHandler type guarantees `error: Error | HTTPResponseError` -- both carry `.message` -- so
    // there is no non-Error case here to guard against, unlike a bare `catch (error: unknown)`.
    console.error(JSON.stringify({ event: "discovery_index_error", route: c.req.path, message: error.message }));
    captureRouteError(error, { route: c.req.path, method: c.req.method });
    return c.json({ error: "internal_error" }, 500);
  });

  app.post("/v1/discovery-index/query", async (c) => {
    const startedAtMs = Date.now();
    try {
      const secret = normalizeSharedSecret(process.env.DISCOVERY_INDEX_SHARED_SECRET);
      // No secret configured ⇒ the service is not ready to authenticate anything; fail closed.
      if (!secret) {
        recordQueryOutcome("service_not_configured", startedAtMs);
        return c.json({ error: "service_not_configured" }, 503);
      }
      if (!verifyBearer(c.req.header("authorization"), secret)) {
        recordQueryOutcome("unauthorized", startedAtMs);
        return c.json({ error: "unauthorized" }, 401);
      }

      const body: unknown = await c.req.json().catch(() => null);
      if (body === null) {
        recordQueryOutcome("bad_request", startedAtMs);
        return c.json({ error: "invalid_json" }, 400);
      }

      const { request } = normalizeDiscoveryIndexRequest(body);
      const response = await runDiscoveryQuery(request.query, {
        github: deps.github,
        resultCache: deps.resultCache,
        policyCache: deps.policyCache,
        cacheTtlMs: deps.cacheTtlMs,
      });
      recordQueryOutcome("ok", startedAtMs);
      return c.json(response);
    } catch (error) {
      // Rethrow to app.onError above, which still owns the 500 response + logging — this catch exists only
      // to record the outcome with the duration/startedAtMs this route handler has and onError doesn't.
      recordQueryOutcome("error", startedAtMs);
      throw error;
    }
  });

  app.post("/v1/discovery-index/soft-claim", async (c) => {
    const startedAtMs = Date.now();
    try {
      const secret = normalizeSharedSecret(process.env.DISCOVERY_INDEX_SHARED_SECRET);
      if (!secret) {
        recordSoftClaimOutcome("service_not_configured", startedAtMs);
        return c.json({ error: "service_not_configured" }, 503);
      }
      if (!verifyBearer(c.req.header("authorization"), secret)) {
        recordSoftClaimOutcome("unauthorized", startedAtMs);
        return c.json({ error: "unauthorized" }, 401);
      }

      const body: unknown = await c.req.json().catch(() => null);
      if (body === null) {
        recordSoftClaimOutcome("bad_request", startedAtMs);
        return c.json({ error: "invalid_json" }, 400);
      }

      const parsed = parseSoftClaimRequest(body);
      if (parsed === null) {
        recordSoftClaimOutcome("bad_request", startedAtMs);
        return c.json({ error: "invalid_request" }, 400);
      }

      const key = softClaimKey(parsed.repoFullName, parsed.issueNumber);
      let outcome: { accepted: boolean; ageMs: number | null };
      if (parsed.action === "release") {
        deps.softClaimStore.release(key);
        outcome = { accepted: true, ageMs: null };
      } else {
        outcome = deps.softClaimStore.claim(key);
      }
      recordSoftClaimOutcome("ok", startedAtMs);
      return c.json({ contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION, ...outcome });
    } catch (error) {
      recordSoftClaimOutcome("error", startedAtMs);
      throw error;
    }
  });

  return app;
}
