// Redis-backed GitHub GET-response cache (#perf). The self-host runtime requires REDIS_URL; when
// GITHUB_CACHE_TTL_SECONDS>0, it caches explicitly stable GitHub API GET responses. A review pass can repeat
// branch-protection and metadata reads across jobs, but mutable PR/issue/check/status reads must stay live. The
// shared GitHub client picks per-endpoint TTL overrides for stable metadata. Keyed by the caller identity + URL +
// response-shaping headers. Only the status + body + content-type plus pagination/validator headers are stored —
// NOT rate-limit headers (a cache hit consumed no quota) or content-encoding (the body is decoded).
import type { Redis } from "ioredis";
import type { CachedGitHubResponse, GitHubResponseCache } from "../github/client";
import { incr } from "./metrics";

const REDIS_GITHUB_RESPONSE_CACHE_METRIC = "gittensory_redis_gh_response_cache_total";
const keyFor = (key: string): string => `gh:resp:${key}`;

function isReplayableCachedStatus(status: unknown): status is number {
  return status === 200 || status === 403 || status === 404;
}

function recordRedisResponseCacheMetric(result: "hit" | "miss" | "set" | "error"): void {
  incr(REDIS_GITHUB_RESPONSE_CACHE_METRIC, { result });
}

export function createRedisResponseCache(
  redis: Redis,
  ttlSeconds: number,
): GitHubResponseCache {
  return {
    async get(key: string) {
      let raw: string | null;
      try {
        raw = await redis.get(keyFor(key));
      } catch (error) {
        recordRedisResponseCacheMetric("error");
        throw error;
      }
      if (!raw) {
        recordRedisResponseCacheMetric("miss");
        return null;
      }
      try {
        const value = JSON.parse(raw) as Partial<CachedGitHubResponse>;
        const status = value.status;
        const cached = isReplayableCachedStatus(status) &&
          typeof value.body === "string" &&
          typeof value.contentType === "string"
          ? {
              status,
              body: value.body,
              contentType: value.contentType,
              ...(typeof value.link === "string" ? { link: value.link } : {}),
              ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
              ...(typeof value.lastModified === "string" ? { lastModified: value.lastModified } : {}),
            }
          : null;
        recordRedisResponseCacheMetric(cached ? "hit" : "miss");
        return cached;
      } catch {
        recordRedisResponseCacheMetric("miss");
        return null;
      }
    },
    async set(key: string, value: CachedGitHubResponse, ttlOverrideSeconds?: number) {
      try {
        await redis.set(
          keyFor(key),
          JSON.stringify(value),
          "EX",
          Math.max(1, ttlOverrideSeconds ?? ttlSeconds),
        );
      } catch (error) {
        recordRedisResponseCacheMetric("error");
        throw error;
      }
      recordRedisResponseCacheMetric("set");
    },
  };
}
