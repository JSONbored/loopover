// Redis-backed GitHub GET-response cache (#perf). The self-host runtime requires REDIS_URL; when
// GITHUB_CACHE_TTL_SECONDS>0, it caches safe GitHub API GET responses for a short TTL. A single review pass makes ~24 GitHub
// fetches (PR data, files, user/org lookups) — many repeated — all network-bound and rate-limited. A short-TTL
// cache dedups those within and across rapid re-reviews, cutting latency and rate-limit pressure, and it
// persists across restarts. Keyed by URL; the TTL bounds staleness. Only the status + body + content-type are
// stored — NOT rate-limit headers (a cache hit consumed no quota) or content-encoding (the body is decoded).
import type { Redis } from "ioredis";
import type { CachedGitHubResponse, GitHubResponseCache } from "../github/app";

const keyFor = (url: string): string => `gh:resp:${url}`;

export function createRedisResponseCache(
  redis: Redis,
  ttlSeconds: number,
): GitHubResponseCache {
  return {
    async get(url: string) {
      const raw = await redis.get(keyFor(url));
      if (!raw) return null;
      try {
        const value = JSON.parse(raw) as Partial<CachedGitHubResponse>;
        return typeof value.status === "number" &&
          typeof value.body === "string" &&
          typeof value.contentType === "string"
          ? {
              status: value.status,
              body: value.body,
              contentType: value.contentType,
            }
          : null;
      } catch {
        return null;
      }
    },
    async set(url: string, value: CachedGitHubResponse) {
      await redis.set(
        keyFor(url),
        JSON.stringify(value),
        "EX",
        Math.max(1, ttlSeconds),
      );
    },
  };
}
