import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle } from "../../src/orb/federated-bundle";
import {
  __resetFederatedCollectorRateLimitForTest,
  pullPeerBundles,
  pushFederatedBundle,
  resolveCollectorEndpoint,
  type CollectorOpts,
} from "../../src/orb/federated-collector";
import type { FederatedCollectorMode, FocusManifest } from "../../src/signals/focus-manifest";

// #9166: pullPeerBundles/pushFederatedBundle now fall back to a module-level default rate-limit bucket when
// no `opts.bucket` is supplied. Reset it between tests so the many call sites in this file that omit a
// bucket (deliberately, to exercise the "no bucket" default arm) don't leak count across test cases.
afterEach(() => {
  __resetFederatedCollectorRateLimitForTest();
});

const URL_OK = "https://collector.example.org/v1/federated";

/** In-memory DB with the tables the bundle builder reads (mirrors federated-bundle.test.ts's makeDb). */
function makeDb(): D1Database {
  const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
  driver.exec(`
    CREATE TABLE review_audit (
      id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, target_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'gate_decision', decision TEXT,
      source TEXT NOT NULL DEFAULT 'gittensory-native', head_sha TEXT, summary TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE system_flags (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return createD1Adapter(driver);
}

let seq = 0;
/** One fully-resolved PR so the builder has something to bundle. */
async function resolved(db: D1Database, pr: number): Promise<void> {
  for (const [type, decision, at] of [
    ["gate_decision", "merge", "2026-07-10T10:00:00Z"],
    ["pr_outcome", "merged", "2026-07-10T12:00:00Z"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES (?, ?, ?, ?, ?, 'gittensory-native', NULL, ?)`,
      )
      .bind(`c${seq++}`, "owner/repo", `owner/repo#${pr}`, type, decision, at)
      .run();
  }
}

function manifest(
  o: { enabled?: boolean; collectorUrl?: string | null; collectorMode?: FederatedCollectorMode | null; present?: boolean } = {},
): Pick<FocusManifest, "federatedIntelligence"> {
  return {
    federatedIntelligence: {
      present: o.present ?? true,
      enabled: o.enabled ?? true,
      // The TRANSPORT never reads peerKeys — pulled bundles are trust-gated downstream by #6480's import.
      peerKeys: [],
      collectorUrl: o.collectorUrl === undefined ? URL_OK : o.collectorUrl,
      collectorMode: o.collectorMode ?? null,
    },
  };
}

/** Fails the test if the network is touched at all — the literal proof of "opted out ⇒ zero network calls". */
function untouchableFetch(): typeof fetch {
  return new Proxy((() => {}) as unknown as typeof fetch, {
    apply() {
      throw new Error("opted-out client must not make a network call");
    },
  });
}

/** Same, for the database. */
function untouchableDb(): D1Database {
  return new Proxy({} as D1Database, {
    get() {
      throw new Error("opted-out client must not touch the database");
    },
  });
}

const NOW = Date.parse("2026-07-16T00:00:00Z");
/** Deterministic retry: no wall-clock, no Math.random. */
const DETERMINISTIC: CollectorOpts = { sleepFn: async () => undefined, randomFn: () => 0.5, now: NOW };

function bundle(over: Partial<FederatedSignalBundle> = {}): Record<string, unknown> {
  return {
    schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
    instanceId: "abc123",
    generatedAt: "2026-07-16T00:00:00.000Z",
    windowDays: 90,
    decided: 7,
    mergePrecision: 0.9,
    closePrecision: 1,
    fpRate: 0.1,
    fnRate: 0,
    reversalRate: 0.1,
    cycleP50Ms: 1000,
    cycleP95Ms: 2000,
    slopRate: 0,
    copycatRate: 0,
    signature: "f".repeat(64),
    ...over,
  };
}

// #9148: a REAL Response (Node's global fetch API), not a hand-rolled fake — pullPeerBundles now reads
// `.headers`/`.body` (via readOrbIngestBody's bounded reader) in addition to `.ok`/`.status`/`.json()`, so a
// fixture missing those would break every test that goes through the pull path for reasons unrelated to what
// each test actually means to exercise.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("resolveCollectorEndpoint()", () => {
  it("is null unless opted in AND a collector is configured", () => {
    expect(resolveCollectorEndpoint(null, "push")).toBeNull();
    expect(resolveCollectorEndpoint(undefined, "push")).toBeNull();
    expect(resolveCollectorEndpoint({} as Pick<FocusManifest, "federatedIntelligence">, "push")).toBeNull();
    expect(resolveCollectorEndpoint(manifest({ enabled: false }), "push")).toBeNull();
    expect(resolveCollectorEndpoint(manifest({ collectorUrl: null }), "push")).toBeNull();
  });

  it("re-checks the SSRF guard at call time, so a round-tripped snapshot cannot smuggle an unsafe URL", () => {
    expect(resolveCollectorEndpoint(manifest({ collectorUrl: "http://collector.example.org" }), "push")).toBeNull();
    expect(resolveCollectorEndpoint(manifest({ collectorUrl: "https://127.0.0.1/v1" }), "pull")).toBeNull();
  });

  it("honors collectorMode in both directions, defaulting to both", () => {
    expect(resolveCollectorEndpoint(manifest({ collectorMode: null }), "push")).toBe(URL_OK);
    expect(resolveCollectorEndpoint(manifest({ collectorMode: null }), "pull")).toBe(URL_OK);
    expect(resolveCollectorEndpoint(manifest({ collectorMode: "both" }), "push")).toBe(URL_OK);
    expect(resolveCollectorEndpoint(manifest({ collectorMode: "push" }), "push")).toBe(URL_OK);
    expect(resolveCollectorEndpoint(manifest({ collectorMode: "push" }), "pull")).toBeNull();
    expect(resolveCollectorEndpoint(manifest({ collectorMode: "pull" }), "pull")).toBe(URL_OK);
    expect(resolveCollectorEndpoint(manifest({ collectorMode: "pull" }), "push")).toBeNull();
  });
});

describe("pushFederatedBundle() — opted out", () => {
  it("returns false touching neither the database nor the network", async () => {
    for (const m of [null, manifest({ enabled: false }), manifest({ collectorUrl: null }), manifest({ collectorMode: "pull" })]) {
      expect(await pushFederatedBundle(m, untouchableDb(), { fetchFn: untouchableFetch() })).toBe(false);
    }
  });
});

describe("pushFederatedBundle() — opted in", () => {
  it("POSTs exactly the anonymized bundle and leaks no identifier", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    expect(await pushFederatedBundle(manifest(), db, { ...DETERMINISTIC, fetchFn })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_OK);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.schemaVersion).toBe(FEDERATED_BUNDLE_SCHEMA_VERSION);
    expect(sent.signature).toMatch(/^[0-9a-f]{64}$/);
    // The privacy regression test: the wire body carries no identifier of any kind.
    const wire = calls[0]!.init.body as string;
    expect(wire).not.toMatch(/owner\/repo/);
    expect(wire).not.toMatch(/target_id|project|repo_hash|pr_hash/);
  });

  it("returns false when the builder has nothing to send", async () => {
    // enabled:true but the builder returns null only if it throws; an empty DB still yields a bundle, so
    // drive the null path through a DB whose read fails (the builder's own fail-safe).
    const brokenDb = {
      prepare() {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = untouchableFetch(); // nothing to send ⇒ no request
    expect(await pushFederatedBundle(manifest(), brokenDb, { ...DETERMINISTIC, fetchFn })).toBe(false);
    err.mockRestore();
  });
});

describe("push/pull — failure handling never reaches the gate", () => {
  it("retries a 5xx with jittered backoff and gives up after maxAttempts", async () => {
    const db = makeDb();
    await resolved(db, 1);
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({ err: "boom" }, 503);
    }) as unknown as typeof fetch;

    const ok = await pushFederatedBundle(manifest(), db, {
      ...DETERMINISTIC,
      fetchFn,
      maxAttempts: 3,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(3); // all attempts used
    expect(sleeps).toHaveLength(2); // no sleep after the final attempt
    expect(sleeps.every((ms) => ms > 0)).toBe(true); // backoff was actually consulted
  });

  it("does NOT retry a 4xx — an operator misconfiguration fails identically next time", async () => {
    const db = makeDb();
    await resolved(db, 1);
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({ err: "bad request" }, 400);
    }) as unknown as typeof fetch;
    expect(await pushFederatedBundle(manifest(), db, { ...DETERMINISTIC, fetchFn })).toBe(false);
    expect(calls).toBe(1);
  });

  it("swallows a timeout / network throw on both directions", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const fetchFn = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(pushFederatedBundle(manifest(), db, { ...DETERMINISTIC, fetchFn })).resolves.toBe(false);
    await expect(pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn })).resolves.toEqual([]);
  });

  it("returns [] when the response body is not JSON at all", async () => {
    const fetchFn = (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn })).resolves.toEqual([]);
  });
});

describe("pullPeerBundles()", () => {
  it("returns [] touching nothing when opted out or scoped to push only", async () => {
    for (const m of [null, manifest({ enabled: false }), manifest({ collectorUrl: null }), manifest({ collectorMode: "push" })]) {
      expect(await pullPeerBundles(m, { fetchFn: untouchableFetch() })).toEqual([]);
    }
  });

  it("fetches, shape-checks and returns peer bundles", async () => {
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(url).toBe(URL_OK);
      expect(init.method).toBe("GET");
      return jsonResponse([bundle(), bundle({ instanceId: "def456" })]);
    }) as unknown as typeof fetch;
    const got = await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn });
    expect(got).toHaveLength(2);
    expect(got[1]!.instanceId).toBe("def456");
  });

  it("drops entries it does not understand and never verifies signatures (that is #6480/#6477)", async () => {
    const fetchFn = (async () =>
      jsonResponse([
        bundle(),
        bundle({ schemaVersion: 99 }), // a future schema
        { ...bundle(), signature: undefined }, // no signature
        { nope: true },
        null,
        "string",
      ])) as unknown as typeof fetch;
    const got = await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn });
    expect(got).toHaveLength(1);
    // A well-shaped bundle is returned AS-IS, with its signature untouched and unverified.
    expect(got[0]!.signature).toBe("f".repeat(64));
  });

  it("#9148: caps the number of pulled entries even shape-checked, independent of the byte ceiling", async () => {
    const many = Array.from({ length: 250 }, (_, i) => bundle({ instanceId: `inst-${i}` }));
    const fetchFn = (async () => jsonResponse(many)) as unknown as typeof fetch;
    const got = await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn });
    expect(got).toHaveLength(200); // MAX_PULLED_BUNDLES, not the 250 the collector claimed to have
    expect(got[0]!.instanceId).toBe("inst-0");
    expect(got[199]!.instanceId).toBe("inst-199");
  });

  it("#9148: rejects a response over the ingest body's byte ceiling instead of buffering it", async () => {
    const oversized = JSON.stringify([bundle()]).padEnd(2 * 1_048_576, " ");
    const fetchFn = (async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch;
    expect(await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn })).toEqual([]);
  });

  it("returns [] for a non-array payload", async () => {
    const fetchFn = (async () => jsonResponse({ bundles: [bundle()] })) as unknown as typeof fetch;
    expect(await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn })).toEqual([]);
  });
});

describe("rate limiting — a best-effort sync must not hammer a peer", () => {
  it("skips the request entirely when the caller's bucket is exhausted", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const exhausted = { count: 999, windowStartMs: NOW };
    const fetchFn = untouchableFetch();
    expect(await pushFederatedBundle(manifest(), db, { ...DETERMINISTIC, fetchFn, bucket: exhausted })).toBe(false);
    expect(await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn, bucket: exhausted })).toEqual([]);
  });

  it("allows the request when the bucket has room, and when no bucket is supplied at all", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const fetchFn = (async () => jsonResponse([])) as unknown as typeof fetch;
    const fresh = { count: 0, windowStartMs: NOW };
    expect(await pushFederatedBundle(manifest(), db, { ...DETERMINISTIC, fetchFn, bucket: fresh })).toBe(true);
    expect(await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn })).toEqual([]);
  });

  // #9166: the rate limiter was inert at every real call site because the only production caller
  // (buildFederatedBenchmark) never supplied a bucket, and `!opts.bucket` meant "unlimited". These prove the
  // module-level default actually engages and blocks once exhausted, with no caller-supplied bucket at all.
  describe("#9166: the default bucket (no opts.bucket supplied) actually engages", () => {
    it("blocks pull after the limit within one window, using only the module-level default", async () => {
      const fetchFn = (async () => jsonResponse([])) as unknown as typeof fetch;
      let calls = 0;
      const countingFetch = (async (...args: Parameters<typeof fetch>) => {
        calls += 1;
        return fetchFn(...args);
      }) as unknown as typeof fetch;
      for (let i = 0; i < 6; i++) {
        expect(await pullPeerBundles(manifest(), { now: NOW, fetchFn: countingFetch })).toEqual([]);
      }
      expect(calls).toBe(6); // all 6 within the limit went through
      // The 7th, same window, same instant — no bucket supplied by the caller — must now be blocked.
      expect(await pullPeerBundles(manifest(), { now: NOW, fetchFn: countingFetch })).toEqual([]);
      expect(calls).toBe(6); // the 7th never reached fetch at all
    });

    it("blocks push after the limit within one window, using only the module-level default", async () => {
      const db = makeDb();
      await resolved(db, 1);
      let calls = 0;
      const countingFetch = (async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch;
      for (let i = 0; i < 6; i++) {
        expect(await pushFederatedBundle(manifest(), db, { now: NOW, fetchFn: countingFetch })).toBe(true);
      }
      expect(calls).toBe(6);
      expect(await pushFederatedBundle(manifest(), db, { now: NOW, fetchFn: countingFetch })).toBe(false);
      expect(calls).toBe(6);
    });

    it("push and pull are independent default buckets — exhausting one never blocks the other", async () => {
      const db = makeDb();
      await resolved(db, 1);
      const fetchFn = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
      for (let i = 0; i < 6; i++) expect(await pushFederatedBundle(manifest(), db, { now: NOW, fetchFn })).toBe(true);
      expect(await pushFederatedBundle(manifest(), db, { now: NOW, fetchFn })).toBe(false); // push exhausted

      const pullFetch = (async () => jsonResponse([])) as unknown as typeof fetch;
      expect(await pullPeerBundles(manifest(), { now: NOW, fetchFn: pullFetch })).toEqual([]); // pull untouched
    });

    it("resets after the window elapses", async () => {
      const fetchFn = (async () => jsonResponse([])) as unknown as typeof fetch;
      for (let i = 0; i < 6; i++) expect(await pullPeerBundles(manifest(), { now: NOW, fetchFn })).toEqual([]);
      // Same instant again — still exhausted.
      let calls = 0;
      const countingFetch = (async () => {
        calls += 1;
        return jsonResponse([]);
      }) as unknown as typeof fetch;
      expect(await pullPeerBundles(manifest(), { now: NOW, fetchFn: countingFetch })).toEqual([]);
      expect(calls).toBe(0);
      // A full window later, the bucket resets and the request goes through again.
      expect(await pullPeerBundles(manifest(), { now: NOW + 61_000, fetchFn: countingFetch })).toEqual([]);
      expect(calls).toBe(1);
    });
  });
});

describe("defaults", () => {
  it("uses the platform clock and fetch when neither is injected", async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    try {
      // No `now`, no fetchFn, no sleepFn, no randomFn — exercises every default arm.
      expect(await pullPeerBundles(manifest(), {})).toEqual([]);
      expect(called).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("clamps a nonsensical maxAttempts to at least one attempt", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(null, 500);
    }) as unknown as typeof fetch;
    expect(await pullPeerBundles(manifest(), { ...DETERMINISTIC, fetchFn, maxAttempts: 0 })).toEqual([]);
    expect(calls).toBe(1);
  });

  it("honors an explicit timeoutMs and uses the built-in sleep when none is injected", async () => {
    let calls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls += 1;
      expect(init.signal).toBeInstanceOf(AbortSignal); // the timeout is armed on every attempt
      return jsonResponse(null, 500);
    }) as unknown as typeof fetch;
    // No sleepFn => the real setTimeout-backed sleep runs; randomFn 0 keeps the single backoff short.
    const started = Date.now();
    expect(await pullPeerBundles(manifest(), { now: NOW, randomFn: () => 0, fetchFn, timeoutMs: 1_000, maxAttempts: 2 })).toEqual([]);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200); // it genuinely waited
  });

  it("pushes with the platform clock when no now is injected", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const fetchFn = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    expect(await pushFederatedBundle(manifest(), db, { fetchFn })).toBe(true);
  });
});

describe("total fail-safety", () => {
  // The gate must survive even a misbehaving injected dependency: nothing in this module may throw.
  it("degrades to false rather than throwing when an injected dependency itself throws", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = (async () => jsonResponse(null, 500)) as unknown as typeof fetch;
    await expect(
      pushFederatedBundle(manifest(), db, {
        now: NOW,
        fetchFn,
        randomFn: () => 0.5,
        sleepFn: async () => {
          throw new Error("scheduler exploded");
        },
      }),
    ).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
