import type { Redis } from "ioredis";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSelfhostTransientCacheOwnershipRelease,
  createRedisCache,
  flushOrphanedLocksAtBoot,
  isWebhookDeliveryDuplicate,
  ORPHANED_LOCK_KEY_PATTERNS,
  rememberWebhookDelivery,
  webhookDeliveryCacheKey,
} from "../../src/selfhost/redis-cache";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

/** Minimal in-memory stand-in for the ioredis methods the cache uses. Emulates real Redis SET NX
 *  semantics (refuse + return null when NX is requested and the key already exists) so a test
 *  using this fake actually exercises the atomicity claim() depends on, not just a plain overwrite. */
function fakeRedis(): Redis & { _store: Map<string, string> } {
  const _store = new Map<string, string>();
  return {
    _store,
    async get(k: string) {
      return _store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", _ttl: number, nx?: "NX") {
      if (nx === "NX" && _store.has(k)) return null;
      _store.set(k, v);
      return "OK";
    },
    async del(k: string) {
      _store.delete(k);
      return 1;
    },
    // Emulates the Lua eval releaseIfValue runs: delete k only when its stored value equals the expected arg.
    async eval(_script: string, _numkeys: number, k: string, expected: string) {
      if (_store.get(k) !== expected) return 0;
      _store.delete(k);
      return 1;
    },
  } as unknown as Redis & { _store: Map<string, string> };
}

describe("createRedisCache (#1216 webhook dedup cache)", () => {
  it("get returns null for a missing key", async () => {
    const cache = createRedisCache(fakeRedis());
    expect(await cache.get("missing")).toBeNull();
  });

  it("set then get returns the stored value", async () => {
    const cache = createRedisCache(fakeRedis());
    await cache.set("k", "hello", 60);
    expect(await cache.get("k")).toBe("hello");
  });

  it("del removes the key", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("k", "v", 60);
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("claim atomically sets an absent key and returns true (#2129)", async () => {
    const cache = createRedisCache(fakeRedis());
    expect(await cache.claim("lock", "1", 60)).toBe(true);
    expect(await cache.get("lock")).toBe("1");
  });

  it("claim refuses and returns false when the key is already held, without overwriting it (#2129)", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("lock", "holder-A", 60);
    expect(await cache.claim("lock", "holder-B", 60)).toBe(false);
    expect(await cache.get("lock")).toBe("holder-A"); // the second claimant never overwrote the first
  });

  it("claim propagates a Redis error to the caller (claimAgentMaintenanceLock is responsible for failing open)", async () => {
    const brokenRedis = { async set() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(cache.claim("lock", "1", 60)).rejects.toThrow("connection refused");
  });

  it("releaseIfValue deletes the key only when the stored value matches the caller's own token (#2129)", async () => {
    const r = fakeRedis();
    const cache = createRedisCache(r);
    await cache.set("lock", "holder-a", 60);
    // A stale/different holder's token does not match — the live key is left untouched.
    expect(await cache.releaseIfValue("lock", "holder-b")).toBe(false);
    expect(await cache.get("lock")).toBe("holder-a");
    // The genuine owner's token matches — the key is removed.
    expect(await cache.releaseIfValue("lock", "holder-a")).toBe(true);
    expect(await cache.get("lock")).toBeNull();
  });

  it("releaseIfValue propagates a Redis error to the caller (releaseTransientLockIfOwner treats this as best-effort)", async () => {
    const brokenRedis = { async eval() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(cache.releaseIfValue("lock", "1")).rejects.toThrow("connection refused");
  });

  it("assertSelfhostTransientCacheOwnershipRelease rejects claim() without releaseIfValue at boot (#3153)", () => {
    expect(() =>
      assertSelfhostTransientCacheOwnershipRelease({
        claim: async () => true,
      }),
    ).toThrow(/releaseIfValue/);
    expect(() => assertSelfhostTransientCacheOwnershipRelease(createRedisCache(fakeRedis()))).not.toThrow();
  });
});

describe("isWebhookDeliveryDuplicate (#2075)", () => {
  afterEach(() => resetMetrics());

  it("returns false and does not increment on a first-time delivery", async () => {
    const cache = createRedisCache(fakeRedis());
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-1")).resolves.toBe(false);
    expect(await renderMetrics()).not.toContain('loopover_webhook_dedup_total{backend="redis"}');
  });

  it("returns true and increments loopover_webhook_dedup_total{backend=\"redis\"} when already seen", async () => {
    const cache = createRedisCache(fakeRedis());
    await cache.set(webhookDeliveryCacheKey("delivery-2"), "1", 300);
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-2")).resolves.toBe(true);
    expect(await renderMetrics()).toContain('loopover_webhook_dedup_total{backend="redis"} 1');
  });

  it("returns false without counting a dedup hit, and records an error metric, when Redis get throws (#8363)", async () => {
    const brokenRedis = { async get() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(isWebhookDeliveryDuplicate(cache, "delivery-3")).resolves.toBe(false);
    const rendered = await renderMetrics();
    // Fail-open behavior is unchanged: a cache outage is never counted as a deduplicated delivery.
    expect(rendered).not.toContain('loopover_webhook_dedup_total{backend="redis"}');
    // ...but the outage is now observable, matching redis-token-cache / redis-response-cache.
    expect(rendered).toContain('loopover_redis_webhook_dedup_cache_total{result="error"} 1');
  });

  it("rememberWebhookDelivery records an error metric when the Redis set throws, and still resolves (#8363)", async () => {
    const brokenRedis = { async set() { throw new Error("connection refused"); } } as unknown as Redis;
    const cache = createRedisCache(brokenRedis);
    await expect(rememberWebhookDelivery(cache, "delivery-5")).resolves.toBeUndefined();
    expect(await renderMetrics()).toContain('loopover_redis_webhook_dedup_cache_total{result="error"} 1');
  });

  it("rememberWebhookDelivery stores the delivery key for later dedup", async () => {
    const cache = createRedisCache(fakeRedis());
    await rememberWebhookDelivery(cache, "delivery-4");
    expect(await cache.get(webhookDeliveryCacheKey("delivery-4"))).toBe("1");
  });
});

/** Minimal glob match supporting the one wildcard shape ORPHANED_LOCK_KEY_PATTERNS uses ("prefix:*"). */
function globMatch(pattern: string, key: string): boolean {
  if (!pattern.includes("*")) return pattern === key;
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  return key.startsWith(prefix);
}

/** Fake ioredis client for flushOrphanedLocksAtBoot: `scanStream` emits the matching keys from `_store` as a
 *  single batch (real SCAN would paginate; one batch is sufficient to exercise the consumer's own for-await
 *  loop and del() call), and `del` removes them. */
function fakeScanRedis(initialKeys: string[]): Redis & { _store: Set<string>; scanCalls: string[] } {
  const _store = new Set(initialKeys);
  const scanCalls: string[] = [];
  return {
    _store,
    scanCalls,
    scanStream({ match }: { match: string; count?: number }) {
      scanCalls.push(match);
      const matched = [..._store].filter((key) => globMatch(match, key));
      return Readable.from(matched.length > 0 ? [matched] : []);
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (_store.delete(key)) removed += 1;
      return removed;
    },
  } as unknown as Redis & { _store: Set<string>; scanCalls: string[] };
}

describe("flushOrphanedLocksAtBoot (#9021)", () => {
  it("deletes every key matching the configured orphaned-lock patterns and leaves everything else alone", async () => {
    const redis = fakeScanRedis([
      "pr-actuation-lock:owner/repo#1",
      "ai-review-lock:owner/repo#1@sha1:block",
      "contributor-cap-wake:owner/repo#1#sha1",
      "contributor-cap-lock:owner/repo:alice",
      // Must survive: not exclusivity locks, each has its own restart-survival contract.
      "delivery:abc123",
      "pr-panel-retrigger-pending:owner/repo#1",
      "ci-pending-first-seen:owner/repo#1",
      "fresh-rebase-forced:owner/repo#1",
    ]);

    const deleted = await flushOrphanedLocksAtBoot(redis);

    expect(deleted).toBe(4);
    expect([...redis._store].sort()).toEqual(
      ["delivery:abc123", "pr-panel-retrigger-pending:owner/repo#1", "ci-pending-first-seen:owner/repo#1", "fresh-rebase-forced:owner/repo#1"].sort(),
    );
    // Scanned every configured pattern, not just a subset.
    expect(redis.scanCalls.sort()).toEqual([...ORPHANED_LOCK_KEY_PATTERNS].sort());
  });

  it("returns 0 and never throws when nothing matches", async () => {
    const redis = fakeScanRedis(["delivery:only-this"]);
    await expect(flushOrphanedLocksAtBoot(redis)).resolves.toBe(0);
  });

  it("is best-effort: a scan failure for one pattern never blocks the others or startup itself", async () => {
    const redis = fakeScanRedis(["ai-review-lock:owner/repo#1@sha1:block", "contributor-cap-lock:owner/repo:alice"]);
    const original = redis.scanStream.bind(redis);
    redis.scanStream = ((opts: { match: string; count?: number }) => {
      if (opts.match === "pr-actuation-lock:*") throw new Error("redis connection dropped");
      return original(opts);
    }) as typeof redis.scanStream;

    await expect(flushOrphanedLocksAtBoot(redis)).resolves.toBe(2); // ai-review-lock + contributor-cap-lock still flushed
    expect(redis._store.has("ai-review-lock:owner/repo#1@sha1:block")).toBe(false);
    expect(redis._store.has("contributor-cap-lock:owner/repo:alice")).toBe(false);
  });
});
