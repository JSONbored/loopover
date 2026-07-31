import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_MAX_ENTRIES, TtlCache } from "../../../packages/discovery-index/src/cache";

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
    it("evicts the oldest-inserted entry once the cap is exceeded", () => {
      const cache = new TtlCache<string>(Date.now, 2);
      cache.set("a", "1", 1000);
      cache.set("b", "2", 1000);
      cache.set("c", "3", 1000);
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("c")).toBe("3");
    });

    it("drops an already-expired entry before falling back to oldest-inserted eviction", () => {
      const c = clock();
      const cache = new TtlCache<string>(c.now, 2);
      cache.set("a", "1", 100);
      c.advance(101); // "a" is now expired but not yet lazily evicted
      cache.set("b", "2", 1000);
      cache.set("c", "3", 1000);
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
      expect(cache.get("c")).toBe("3");
    });

    it("overwriting an existing key never evicts, even at the cap", () => {
      const cache = new TtlCache<string>(Date.now, 2);
      cache.set("a", "1", 1000);
      cache.set("b", "2", 1000);
      cache.set("a", "1-updated", 1000);
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBe("1-updated");
      expect(cache.get("b")).toBe("2");
    });

    it("falls back to DEFAULT_CACHE_MAX_ENTRIES when no cap is given", () => {
      const cache = new TtlCache<string>();
      for (let i = 0; i < DEFAULT_CACHE_MAX_ENTRIES + 1; i += 1) {
        cache.set(`k${i}`, String(i), 1000);
      }
      expect(cache.size).toBe(DEFAULT_CACHE_MAX_ENTRIES);
    });

    it("a cap of 0 never grows the store past a single entry and doesn't hang", () => {
      const cache = new TtlCache<string>(Date.now, 0);
      cache.set("a", "1", 1000);
      cache.set("b", "2", 1000);
      expect(cache.size).toBe(1);
      expect(cache.get("b")).toBe("2");
    });

    it("REGRESSION: a key that is never re-read must not survive past the entry cap", () => {
      const cap = 3;
      const cache = new TtlCache<number>(Date.now, cap);
      for (let i = 0; i < cap + 50; i += 1) {
        cache.set(`scope-${i}`, i, 1000);
        expect(cache.size).toBeLessThanOrEqual(cap);
      }
      expect(cache.size).toBe(cap);
    });
  });

  describe("server.ts wiring (#10029)", () => {
    // server.ts is a process entrypoint and isn't unit-imported (see its own header comment), so assert
    // the constructor wiring by reading its source text rather than importing it.
    const SERVER_SOURCE = readFileSync("packages/discovery-index/src/server.ts", "utf8");

    it("passes DEFAULT_CACHE_MAX_ENTRIES to all three TtlCache construction sites", () => {
      const ttlCacheConstructions = SERVER_SOURCE.match(/new TtlCache[^)]*\([^)]*\)/g) ?? [];
      expect(ttlCacheConstructions.length).toBe(3);
      for (const construction of ttlCacheConstructions) {
        expect(construction).toContain("DEFAULT_CACHE_MAX_ENTRIES");
      }
    });

    it("imports DEFAULT_CACHE_MAX_ENTRIES from ./cache.js", () => {
      expect(SERVER_SOURCE).toMatch(/import\s*\{[^}]*DEFAULT_CACHE_MAX_ENTRIES[^}]*\}\s*from\s*"\.\/cache\.js"/);
    });
  });
});
