import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  queryPackageWeight,
  resetWeightCacheForTest,
  weightCacheSizeForTest,
} from "../dist/analyzers/heavy-dependency.js";

beforeEach(() => {
  resetWeightCacheForTest();
});

afterEach(() => {
  resetWeightCacheForTest();
  mock.timers.reset();
});

function bundlephobiaResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      installSize: 1_000_000,
      size: 100_000,
      gzip: 30_000,
      dependencyCount: 3,
      ...overrides,
    }),
    { status: 200 },
  );
}

test("queryPackageWeight: caches a successful lookup so a repeat call for the same pkg@version never re-fetches", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return bundlephobiaResponse();
  };

  const first = await queryPackageWeight("left-pad", "1.3.0", fetchImpl);
  assert.equal(calls, 1);
  assert.deepEqual(first, {
    installSizeBytes: 1_000_000,
    bundleSizeBytes: 100_000,
    gzipSizeBytes: 30_000,
    dependencyCount: 3,
  });

  const second = await queryPackageWeight("left-pad", "1.3.0", fetchImpl);
  assert.equal(calls, 1, "the second lookup must be served from cache, not a new fetch");
  assert.deepEqual(second, first);
});

test("queryPackageWeight: a cached entry expires after its TTL and is re-fetched", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return bundlephobiaResponse();
    };

    await queryPackageWeight("left-pad", "1.3.0", fetchImpl);
    assert.equal(calls, 1);

    await queryPackageWeight("left-pad", "1.3.0", fetchImpl);
    assert.equal(calls, 1, "still within the 1h TTL");

    // Advance past the 1-hour TTL.
    mock.timers.tick(60 * 60 * 1000 + 1);

    await queryPackageWeight("left-pad", "1.3.0", fetchImpl);
    assert.equal(calls, 2, "past the TTL, the cache entry must be treated as stale");
  } finally {
    mock.timers.reset();
  }
});

test("queryPackageWeight: caches a definitive http_error (e.g. 404) so it is not retried every call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  };

  const first = await queryPackageWeight("does-not-exist", "1.0.0", fetchImpl);
  assert.equal(first, null);
  assert.equal(calls, 1);

  const second = await queryPackageWeight("does-not-exist", "1.0.0", fetchImpl);
  assert.equal(second, null);
  assert.equal(calls, 1, "a definitive http_error result must be cached");
});

test("queryPackageWeight: does NOT cache a transient failure (network_error), so the next call retries", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection refused");
  };

  const first = await queryPackageWeight("flaky-pkg", "2.0.0", fetchImpl);
  assert.equal(first, null);
  assert.equal(calls, 1);

  const second = await queryPackageWeight("flaky-pkg", "2.0.0", fetchImpl);
  assert.equal(second, null);
  assert.equal(calls, 2, "a transient failure must not be cached — the next call should retry");
});

test("queryPackageWeight: the cache is bounded, evicting the oldest entry once at capacity", async () => {
  const fetchImpl = async () => bundlephobiaResponse();

  // MAX_WEIGHT_CACHE_ENTRIES is 1000 — fill it, then add one more distinct key.
  for (let index = 0; index < 1000; index += 1) {
    await queryPackageWeight(`pkg-${index}`, "1.0.0", fetchImpl);
  }
  assert.equal(weightCacheSizeForTest(), 1000);

  await queryPackageWeight("pkg-1000", "1.0.0", fetchImpl);
  assert.ok(
    weightCacheSizeForTest() <= 1000,
    "the cache must never grow past its bound, even under many distinct pkg@version specs",
  );

  // The evicted (oldest) entry must be re-fetched, proving it was actually dropped, not just capped on paper.
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return bundlephobiaResponse();
  };
  await queryPackageWeight("pkg-0", "1.0.0", countingFetch);
  assert.equal(calls, 1, "the oldest entry (pkg-0) should have been evicted and require a real re-fetch");
});
