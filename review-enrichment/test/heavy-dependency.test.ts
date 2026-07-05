import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  queryPackageWeight,
  resetWeightCacheForTest,
  weightCacheSizeForTest,
  countPackagePatchUsages,
  isHeavyPackageWeight,
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

test("queryPackageWeight: rejects overlong package specs before fetch or cache (regression for unbounded cache keys)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return bundlephobiaResponse();
  };

  const overlongVersion = `1.0.0+${"a".repeat(256)}`;
  const result = await queryPackageWeight("left-pad", overlongVersion, fetchImpl);

  assert.equal(result, null);
  assert.equal(calls, 0, "overlong versions must not be fetched or cached");
  assert.equal(weightCacheSizeForTest(), 0);
});

test("queryPackageWeight: accepts package specs at the configured length bounds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return bundlephobiaResponse();
  };
  const scopedNameAtNpmLimit = `@${"a".repeat(106)}/${"b".repeat(106)}`;
  const versionAtLimit = `1.0.0+${"a".repeat(250)}`;

  const result = await queryPackageWeight(scopedNameAtNpmLimit, versionAtLimit, fetchImpl);

  assert.equal(calls, 1);
  assert.equal(result?.installSizeBytes, 1_000_000);
  assert.equal(weightCacheSizeForTest(), 1);
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

const patchFile = (path, lines) => ({
  path,
  patch: `@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
});

test("countPackagePatchUsages: counts multiple require/import occurrences of the same package", () => {
  const files = [
    patchFile("src/a.ts", [`const x = require("left-pad");`, `import y from "left-pad";`]),
  ];
  const usage = countPackagePatchUsages(files, "left-pad");
  assert.equal(usage.usageCount, 2);
  assert.deepEqual(usage.usageLocations, [
    { file: "src/a.ts", line: 1 },
    { file: "src/a.ts", line: 2 },
  ]);
});

test("countPackagePatchUsages: a package with no added-line usage returns zero and an empty location list", () => {
  const files = [patchFile("src/a.ts", [`const x = require("other-pkg");`])];
  assert.deepEqual(countPackagePatchUsages(files, "left-pad"), { usageCount: 0, usageLocations: [] });
});

test("countPackagePatchUsages: an empty files array returns zero usage", () => {
  assert.deepEqual(countPackagePatchUsages([], "left-pad"), { usageCount: 0, usageLocations: [] });
});

test("countPackagePatchUsages: usageLocations caps at TRIVIAL_USAGE_MAX (2) but usageCount keeps counting past it", () => {
  const files = [
    patchFile("src/a.ts", [`require("left-pad");`, `require("left-pad");`, `require("left-pad");`]),
  ];
  const usage = countPackagePatchUsages(files, "left-pad");
  assert.equal(usage.usageCount, 3);
  assert.equal(usage.usageLocations.length, 2);
});

test("countPackagePatchUsages: an identical import line repeated across files counts each occurrence independently, not deduped", () => {
  const files = [patchFile("src/a.ts", [`import "left-pad";`]), patchFile("src/b.ts", [`import "left-pad";`])];
  const usage = countPackagePatchUsages(files, "left-pad");
  assert.equal(usage.usageCount, 2);
  assert.deepEqual(usage.usageLocations, [
    { file: "src/a.ts", line: 1 },
    { file: "src/b.ts", line: 1 },
  ]);
});

test("countPackagePatchUsages: resolves a deep subpath import and a scoped package to their package root", () => {
  const files = [
    patchFile("src/a.ts", [`import debounce from "lodash/debounce";`, `import z from "@scope/pkg/sub/path";`]),
  ];
  assert.equal(countPackagePatchUsages(files, "lodash").usageCount, 1);
  assert.equal(countPackagePatchUsages(files, "@scope/pkg").usageCount, 1);
});

test("isHeavyPackageWeight: flags at-or-above each individual threshold (install, bundle, gzip)", () => {
  assert.equal(
    isHeavyPackageWeight({ installSizeBytes: 500_000, bundleSizeBytes: null, gzipSizeBytes: null, dependencyCount: null }),
    true,
  );
  assert.equal(
    isHeavyPackageWeight({ installSizeBytes: null, bundleSizeBytes: 80_000, gzipSizeBytes: null, dependencyCount: null }),
    true,
  );
  assert.equal(
    isHeavyPackageWeight({ installSizeBytes: null, bundleSizeBytes: null, gzipSizeBytes: 25_000, dependencyCount: null }),
    true,
  );
});

test("isHeavyPackageWeight: does not flag just below every threshold, or all-null weights", () => {
  assert.equal(
    isHeavyPackageWeight({ installSizeBytes: 499_999, bundleSizeBytes: 79_999, gzipSizeBytes: 24_999, dependencyCount: null }),
    false,
  );
  assert.equal(
    isHeavyPackageWeight({ installSizeBytes: null, bundleSizeBytes: null, gzipSizeBytes: null, dependencyCount: null }),
    false,
  );
});
