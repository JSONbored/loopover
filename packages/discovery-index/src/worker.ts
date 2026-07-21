// Cloudflare Worker + Container entry point for the discovery-index service (#7167). Pure infra glue: it
// adds NO new application logic and does not modify server.ts/app.ts's existing behavior -- it routes
// incoming requests to a Container instance running the SAME, unmodified Docker image server.ts's own
// Dockerfile already builds.
//
// A SINGLE fixed-name instance, not a load-balanced pool. This is a correctness requirement, not a
// preference: the service's result cache (cache.ts) and soft-claim dedup store (soft-claim.ts) are both
// per-process in-memory state. Cloudflare's own getRandom() helper spreads requests across an interchangeable
// pool of container instances, each with independent memory -- two concurrent "claim" calls for the same
// repo/issue landing on two different pool instances would each see an empty store and both succeed,
// silently breaking soft-claim's one-claim-wins guarantee. Routing every request to one fixed instance name
// keeps the existing in-process TtlCache/SoftClaimStore logic correct exactly as already tested, with zero
// changes to that logic. If real load ever outgrows a single instance, the fix is moving soft-claim state
// into the Durable Object's own transactional storage (real cross-instance consistency), not multiplying
// instances under the current in-memory design.
//
// Also applies the blanket IP-keyed rate limit (rate-limiter.ts, #4250's "rate-limiting/abuse posture"
// deliverable) at the Worker layer, in front of the Container -- an abusive caller gets rejected before it
// ever reaches (and wakes) the container instance.
//
// Not unit-tested: exercised only by real Cloudflare Containers infrastructure, matching server.ts's own
// existing exclusion (see codecov.yml / vitest.config.ts).
import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { DiscoveryIndexRateLimiter, enforceDiscoveryIndexRateLimit } from "./rate-limiter.js";

export { DiscoveryIndexRateLimiter };

const SINGLETON_INSTANCE_NAME = "discovery-index-singleton";

export class DiscoveryIndexContainer extends Container {
  override defaultPort = 8080;
  // Idle timeout before the container sleeps (cost control for an opt-in, low-traffic shared service) --
  // long enough that normal miner query cadence (cache TTL is 5 minutes, per README.md) doesn't constantly
  // pay a cold-start penalty between requests.
  override sleepAfter = "10m";
  // Sentry vars (#4934) are forwarded whether or not they're actually configured -- initSentry/
  // upload-sourcemaps.ts (both running inside the container, not this Worker) already no-op cleanly on an
  // empty/unset SENTRY_DSN/SENTRY_AUTH_TOKEN; nothing here needs to conditionally omit them. Container.envVars
  // requires Record<string, string> (no undefined) -- SENTRY_RELEASE/SENTRY_AUTH_TOKEN are optional (env.d.ts),
  // so they're coerced to "" here, which initSentry's own nonBlank() already treats identically to unset.
  override envVars = {
    DISCOVERY_INDEX_SHARED_SECRET: env.DISCOVERY_INDEX_SHARED_SECRET,
    DISCOVERY_INDEX_GITHUB_TOKEN: env.DISCOVERY_INDEX_GITHUB_TOKEN,
    SENTRY_DSN: env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    SENTRY_RELEASE: env.SENTRY_RELEASE ?? "",
    SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN ?? "",
    SENTRY_ORG: env.SENTRY_ORG,
    SENTRY_PROJECT: env.SENTRY_PROJECT,
  };
}

interface WorkerEnv {
  DISCOVERY_INDEX_CONTAINER: DurableObjectNamespace<DiscoveryIndexContainer>;
  DISCOVERY_INDEX_RATE_LIMITER: DurableObjectNamespace<DiscoveryIndexRateLimiter>;
  DISCOVERY_INDEX_SHARED_SECRET: string;
  DISCOVERY_INDEX_GITHUB_TOKEN: string;
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
  SENTRY_RELEASE: string;
  SENTRY_AUTH_TOKEN: string;
  SENTRY_ORG: string;
  SENTRY_PROJECT: string;
}

// /health, /ready, /metrics are cheap liveness/monitoring routes a legitimate uptime checker may poll
// frequently -- only the real, potentially-abusable work (query/soft-claim) is rate-limited, mirroring the
// main app's own isPreAuthRateLimitPath exclusion for equivalent routes (src/auth/rate-limit.ts).
function isRateLimited(path: string): boolean {
  return path.startsWith("/v1/discovery-index/");
}

export default {
  async fetch(request: Request, workerEnv: WorkerEnv): Promise<Response> {
    if (isRateLimited(new URL(request.url).pathname)) {
      const limited = await enforceDiscoveryIndexRateLimit(request, workerEnv.DISCOVERY_INDEX_RATE_LIMITER);
      if (limited) return limited;
    }
    const container = workerEnv.DISCOVERY_INDEX_CONTAINER.getByName(SINGLETON_INSTANCE_NAME);
    return container.fetch(request);
  },
};
