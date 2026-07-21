// LoopOver discovery-index service (#4250, #7164) process entrypoint. Wires real dependencies (this
// service's own GitHub token, in-memory TTL caches) and starts the Node HTTP listener — kept thin
// deliberately; the actual app/routes live in app.ts, which is what tests import (this file, like
// review-enrichment/src/server.ts, is exercised by the Docker build+boot path, not unit-covered — importing
// it would bind a real port as a side effect). See codecov.yml's ignore list for the same treatment given
// to the main app's own src/server.ts.
import { serve } from "@hono/node-server";
import type { AiPolicyVerdict, DiscoveryIndexCandidate } from "@loopover/engine";
import { createApp } from "./app.js";
import { TtlCache } from "./cache.js";
import { DEFAULT_CACHE_TTL_MS } from "./discovery-query.js";
import { GitHubClient } from "./github-client.js";
import { captureUnhandledError, flushSentry, initSentry, resolveSentryEnvironment } from "./sentry.js";
import { DEFAULT_SOFT_CLAIM_TTL_MS, SoftClaimStore } from "./soft-claim.js";

const sentryEnabled = await initSentry(process.env);
if (sentryEnabled) {
  console.log(JSON.stringify({ event: "discovery_index_sentry", environment: resolveSentryEnvironment(process.env) }));
}

const githubToken = process.env.DISCOVERY_INDEX_GITHUB_TOKEN ?? "";
const configuredCacheTtlMs = Number(process.env.DISCOVERY_INDEX_CACHE_TTL_MS);
const cacheTtlMs = Number.isFinite(configuredCacheTtlMs) && configuredCacheTtlMs > 0 ? configuredCacheTtlMs : DEFAULT_CACHE_TTL_MS;
const configuredSoftClaimTtlMs = Number(process.env.DISCOVERY_INDEX_SOFT_CLAIM_TTL_MS);
const softClaimTtlMs =
  Number.isFinite(configuredSoftClaimTtlMs) && configuredSoftClaimTtlMs > 0 ? configuredSoftClaimTtlMs : DEFAULT_SOFT_CLAIM_TTL_MS;

const app = createApp({
  github: new GitHubClient({ token: githubToken }),
  resultCache: new TtlCache<DiscoveryIndexCandidate[]>(),
  policyCache: new TtlCache<AiPolicyVerdict>(),
  cacheTtlMs,
  softClaimStore: new SoftClaimStore(new TtlCache(), softClaimTtlMs),
  githubConfigured: githubToken.trim().length > 0,
});

const port = Number(process.env.PORT ?? "8080");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ event: "discovery_index_listening", port: info.port }));
});

process.on("unhandledRejection", (reason) => {
  captureUnhandledError(reason, { event: "discovery_index_unhandled_rejection" });
});

process.on("uncaughtException", (error) => {
  captureUnhandledError(error, { event: "discovery_index_uncaught_exception" });
  void flushSentry().finally(() => process.exit(1));
});

process.on("SIGTERM", () => {
  void flushSentry().finally(() => process.exit(0));
});

export { app };
