// Redis-backed GitHub GET-response cache (#perf). The self-host runtime requires REDIS_URL; when
// GITHUB_CACHE_TTL_SECONDS>0, it caches explicitly stable GitHub API GET responses. A review pass can repeat
// branch-protection and metadata reads across jobs, but mutable PR/issue/check/status reads must stay live. The
// shared GitHub client picks per-endpoint TTL overrides for stable metadata. Keyed by the caller identity + URL +
// response-shaping headers. Only the status + body + content-type plus pagination/validator headers are stored —
// NOT rate-limit headers (a cache hit consumed no quota) or content-encoding (the body is decoded).
import type { Redis } from "ioredis";
import type { CachedGitHubResponse, GitHubResponseCache } from "../github/client";

const keyFor = (key: string): string => `gh:resp:${key}`;

export function createRedisResponseCache(
  redis: Redis,
  ttlSeconds: number,
): GitHubResponseCache {
  return {
    async get(key: string) {
      const raw = await redis.get(keyFor(key));
      if (!raw) return null;
      try {
        const value = JSON.parse(raw) as Partial<CachedGitHubResponse>;
        return typeof value.status === "number" &&
          value.status === 200 &&
          typeof value.body === "string" &&
          typeof value.contentType === "string"
          ? {
              status: value.status,
              body: value.body,
              contentType: value.contentType,
              ...(typeof value.link === "string" ? { link: value.link } : {}),
              ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
              ...(typeof value.lastModified === "string" ? { lastModified: value.lastModified } : {}),
            }
          : null;
      } catch {
        return null;
      }
    },
    async set(key: string, value: CachedGitHubResponse, ttlOverrideSeconds?: number) {
      await redis.set(
        keyFor(key),
        JSON.stringify(value),
        "EX",
        Math.max(1, ttlOverrideSeconds ?? ttlSeconds),
      );
    },
  };
}
