// Redis-backed installation-token store (#perf). The self-host runtime requires REDIS_URL and backs
// github/app.ts's installation-token cache with Redis so warm tokens SURVIVE restarts/deploys. The default
// in-isolate Map dies on every restart, so a brokered self-host re-mints a token (an Orb round-trip) on the
// next call after each cold start — wasteful when the container restarts often. Keyed by installation id, with
// the TTL set to the token's own remaining lifetime so the entry self-expires exactly when the token does.
// Also makes the cache shared across instances if the stack is ever scaled horizontally.
import type { Redis } from "ioredis";
import type { InstallationTokenStore } from "../github/app";
import { incr } from "./metrics";

const REDIS_TOKEN_CACHE_METRIC = "loopover_redis_token_cache_total";

const keyFor = (installationId: number): string =>
  `gh:insttoken:${installationId}`;

function recordTokenCacheMetric(result: "hit" | "miss" | "error"): void {
  incr(REDIS_TOKEN_CACHE_METRIC, { result });
}

export function createRedisTokenCache(redis: Redis): InstallationTokenStore {
  return {
    async get(installationId: number) {
      // Fail open on a connection error, same contract as redis-cache.ts's webhook-dedup cache: the caller
      // (github/app.ts's readCachedToken -> createInstallationToken) has no try/catch of its own, so an
      // uncaught error here would hard-fail GitHub App token minting on every Redis hiccup instead of just
      // costing one extra real mint. Unlike redis-cache.ts, still record a metric so the failure isn't invisible.
      let raw: string | null;
      try {
        raw = await redis.get(keyFor(installationId));
      } catch {
        recordTokenCacheMetric("error");
        return null;
      }
      if (!raw) {
        recordTokenCacheMetric("miss");
        return null;
      }
      try {
        const value = JSON.parse(raw) as {
          token?: unknown;
          expiresAtMs?: unknown;
        };
        if (typeof value.token !== "string") {
          recordTokenCacheMetric("miss");
          return null;
        }
        if (typeof value.expiresAtMs !== "number") {
          recordTokenCacheMetric("miss");
          return null;
        }
        recordTokenCacheMetric("hit");
        return { token: value.token, expiresAtMs: value.expiresAtMs };
      } catch {
        recordTokenCacheMetric("miss");
        return null;
      }
    },
    async set(
      installationId: number,
      value: { token: string; expiresAtMs: number },
    ) {
      // Floor at 1s; a token already inside the safety margin still gets cached briefly rather than not at all.
      const ttlSeconds = Math.max(
        1,
        Math.floor((value.expiresAtMs - Date.now()) / 1000),
      );
      // Fail open on a connection error, same contract as get() above: the caller (github/app.ts's
      // createInstallationToken, right after successfully minting a fresh token) has no try/catch of its own,
      // so an uncaught error here would turn an otherwise-successful mint into a hard failure over a transient
      // cache-write hiccup. The token was already obtained from GitHub before this call, so a write failure
      // just costs one extra real mint next time -- never the caller's job to fail.
      try {
        await redis.set(
          keyFor(installationId),
          JSON.stringify(value),
          "EX",
          ttlSeconds,
        );
      } catch {
        recordTokenCacheMetric("error");
      }
    },
  };
}
