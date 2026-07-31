import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_MAX_ENTRIES, TtlCache } from "../../../packages/discovery-index/src/cache";

const SERVER_SOURCE = readFileSync("packages/discovery-index/src/server.ts", "utf8");

function clock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("discovery-index TtlCache (#7164)", () => {
  it("returns undefined for an absent key", () => {
    const cache = new TtlCache<string>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a set value before expiry, and evicts it after", () => {
    const c = clock();
    const cache = new TtlCache<string>(c.now);
    cache.set("k", "v", 100);
    expect(cache.get("k")).toBe("v");
    expect(cache.size).toBe(1);
    c.advance(101);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0); // lazily evicted on read
  });

  it("clamps a negative ttl to immediate expiry", () => {
    const cache = new TtlCache<string>();
    cache.set("k", "v", -50);
    expect(cache.get("k")).toBeUndefined();
  });

  it("delete removes a key and clear empties the store", () => {
    const cache = new TtlCache<string>();
    cache.set("a", "1", 1000);
    cache.set("b", "2", 1000);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("getOrCompute computes and caches on miss, and skips compute on hit", async () => {
    const cache = new TtlCache<number>();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    expect(await cache.getOrCompute("k", 1000, compute)).toBe(42);
    expect(await cache.getOrCompute("k", 1000, compute)).toBe(42);
    expect(calls).toBe(1);
  });

  it("getOrCompute recomputes after the cached value expires", async () => {
    const c = clock();
    const cache = new TtlCache<number>(c.now);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await cache.getOrCompute("k", 100, compute)).toBe(1);
    c.advance(101);
    expect(await cache.getOrCompute("k", 100, compute)).toBe(2);
    expect(calls).toBe(2);
  });

  describe("max-entry cap", () => {
    it("exports a positive default cap constant", () => {
      expect(Number.isInteger(DEFAULT_CACHE_MAX_ENTRIES)).toBe(true);
      expect(DEFAULT_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    });

    it("with a cap of 2, a third distinct key evicts the oldest and stays at size 2", () => {
      const cache = new TtlCache<string>(Date.now, 2);
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000);
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("c")).toBe("3");
    });

    it("under the cap, set does not evict anything", () => {
      const cache = new TtlCache<string>(Date.now, 2);
      cache.set("a", "1", 60_000);
      expect(cache.size).toBe(1);
      expect(cache.get("a")).toBe("1");
    });

    it("evicts already-expired entries before falling back to oldest-inserted eviction", () => {
      const c = clock();
      const cache = new TtlCache<string>(c.now, 2);
      cache.set("a", "1", 100); // will be expired
      c.advance(101);
      cache.set("b", "2", 60_000); // live
      cache.set("c", "3", 60_000); // expired-drop of "a" makes room, "b" survives
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
      expect(cache.get("c")).toBe("3");
    });

    it("REGRESSION: a key that is never re-read must not survive past the entry cap", () => {
      const cap = 10;
      const cache = new TtlCache<number>(Date.now, cap);
      for (let i = 0; i < cap + 50; i++) {
        cache.set(`key-${i}`, i, 60_000);
        expect(cache.size).toBeLessThanOrEqual(cap);
      }
      expect(cache.size).toBe(cap);
    });

    it("overwriting an already-present key at the cap does not evict any other entry", () => {
      const cache = new TtlCache<string>(Date.now, 2);
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("b", "2-updated", 60_000);
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBe("1");
      expect(cache.get("b")).toBe("2-updated");
    });

    it("falls back to the default cap when no cap is passed to the constructor", () => {
      const cache = new TtlCache<number>();
      for (let i = 0; i < DEFAULT_CACHE_MAX_ENTRIES + 5; i++) {
        cache.set(`key-${i}`, i, 60_000);
      }
      expect(cache.size).toBe(DEFAULT_CACHE_MAX_ENTRIES);
    });
  });

  describe("server.ts wiring (#7164)", () => {
    it("passes an explicit cap to all three long-lived cache instances", () => {
      const explicitCapSites = [...SERVER_SOURCE.matchAll(/new TtlCache(?:<[^>]*>)?\([^)]*DEFAULT_CACHE_MAX_ENTRIES[^)]*\)/g)];
      expect(explicitCapSites).toHaveLength(3);
    });

    it("imports the cap constant from cache.ts", () => {
      expect(SERVER_SOURCE).toMatch(/import\s*\{[^}]*DEFAULT_CACHE_MAX_ENTRIES[^}]*\}\s*from\s*"\.\/cache\.js"/);
    });
  });
});
