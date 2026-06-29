// Redis-backed installation-token store (#perf). The self-host runtime requires REDIS_URL and backs
// github/app.ts's installation-token cache with Redis so warm tokens SURVIVE restarts/deploys. The default
// in-isolate Map dies on every restart, so a brokered self-host re-mints a token (an Orb round-trip) on the
// next call after each cold start — wasteful when the container restarts often. Keyed by installation id, with
// the TTL set to the token's own remaining lifetime so the entry self-expires exactly when the token does.
// Also makes the cache shared across instances if the stack is ever scaled horizontally.
import type { Redis } from "ioredis";
import type { InstallationTokenStore } from "../github/app";

const keyFor = (installationId: number): string =>
  `gh:insttoken:${installationId}`;

export function createRedisTokenCache(redis: Redis): InstallationTokenStore {
  return {
    async get(installationId: number) {
      const raw = await redis.get(keyFor(installationId));
      if (!raw) return null;
      try {
        const value = JSON.parse(raw) as {
          token?: unknown;
          expiresAtMs?: unknown;
        };
        return typeof value.token === "string" &&
          typeof value.expiresAtMs === "number"
          ? { token: value.token, expiresAtMs: value.expiresAtMs }
          : null;
      } catch {
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
      await redis.set(
        keyFor(installationId),
        JSON.stringify(value),
        "EX",
        ttlSeconds,
      );
    },
  };
}
