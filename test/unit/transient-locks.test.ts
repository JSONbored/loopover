import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionLock } from "../../src/queue/submission-lock";
import {
  claimContributorCapLock,
  claimPrActuationLock,
  claimTransientLock,
  PrActuationLockContendedError,
  releaseContributorCapLock,
  releasePrActuationLock,
  releaseTransientLockIfOwner,
} from "../../src/queue/transient-locks";
import { createTestEnv } from "../helpers/d1";

// #8896: SubmissionLock DO + claimTransientLock preference / cache fallback.

function memoryDurableObjectState() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      async get(key: string) {
        return storage.get(key);
      },
      async put(key: string, value: unknown) {
        storage.set(key, value);
      },
      async delete(key: string) {
        return storage.delete(key);
      },
    },
  };
}

function lockFromState(state = memoryDurableObjectState()) {
  return new SubmissionLock(state as unknown as DurableObjectState, {} as Env);
}

function claimRequest(ownerToken: string, ttlSeconds = 60) {
  return new Request("https://submission-lock/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerToken, ttlSeconds }),
  });
}

function releaseRequest(ownerToken: string) {
  return new Request("https://submission-lock/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerToken }),
  });
}

/**
 * Namespace stub that routes each lock key to one in-memory SubmissionLock and serializes concurrent
 * fetches per id — the same input-gate serialization real Durable Objects provide.
 */
function submissionLockNamespace(env: Env = {} as Env) {
  const states = new Map<string, ReturnType<typeof memoryDurableObjectState>>();
  const tails = new Map<string, Promise<unknown>>();
  let claimCalls = 0;
  let releaseCalls = 0;

  return {
    get claimCalls() {
      return claimCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      let state = states.get(id);
      if (!state) {
        state = memoryDurableObjectState();
        states.set(id, state);
      }
      return {
        async fetch(input: string, init?: RequestInit) {
          const prev = tails.get(id) ?? Promise.resolve();
          let releaseGate!: () => void;
          const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
          tails.set(
            id,
            prev.then(() => gate),
          );
          await prev;
          try {
            const url = typeof input === "string" ? input : String(input);
            if (url.includes("/claim")) claimCalls += 1;
            if (url.includes("/release")) releaseCalls += 1;
            return await new SubmissionLock(state as unknown as DurableObjectState, env).fetch(
              new Request(input, init),
            );
          } finally {
            releaseGate();
          }
        },
      };
    },
  };
}

describe("SubmissionLock Durable Object (#8896)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants the first claim and rejects a second concurrent claim against the same key", async () => {
    const ns = submissionLockNamespace();
    const env = createTestEnv({
      SUBMISSION_LOCK: ns as unknown as DurableObjectNamespace,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;

    const [first, second] = await Promise.all([
      claimTransientLock(env, "pr-actuation-lock:acme/widgets#1", 600),
      claimTransientLock(env, "pr-actuation-lock:acme/widgets#1", 600),
    ]);

    const acquired = [first, second].filter((claim) => claim.acquired);
    const denied = [first, second].filter((claim) => !claim.acquired);
    expect(acquired).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(acquired[0]?.ownerToken).toEqual(expect.any(String));
    expect(denied[0]?.ownerToken).toBeNull();
    expect(ns.claimCalls).toBe(2);
  });

  it("releases only when the owner token still matches, then allows a new claim", async () => {
    const lock = lockFromState();
    const first = await lock.fetch(claimRequest("token-a"));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ acquired: true });

    const foreignRelease = await lock.fetch(releaseRequest("token-b"));
    await expect(foreignRelease.json()).resolves.toEqual({ released: false });

    const stillHeld = await lock.fetch(claimRequest("token-b"));
    await expect(stillHeld.json()).resolves.toEqual({ acquired: false });

    const released = await lock.fetch(releaseRequest("token-a"));
    await expect(released.json()).resolves.toEqual({ released: true });

    const reclaim = await lock.fetch(claimRequest("token-b"));
    await expect(reclaim.json()).resolves.toEqual({ acquired: true });
  });

  it("allows a new claim after the TTL expires", async () => {
    const lock = lockFromState();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await expect(lock.fetch(claimRequest("token-a", 1)).then((r) => r.json())).resolves.toEqual({
      acquired: true,
    });

    now.mockReturnValue(1_500);
    await expect(lock.fetch(claimRequest("token-b", 1)).then((r) => r.json())).resolves.toEqual({
      acquired: false,
    });

    now.mockReturnValue(2_001);
    await expect(lock.fetch(claimRequest("token-b", 1)).then((r) => r.json())).resolves.toEqual({
      acquired: true,
    });
  });

  it("rejects malformed claim/release bodies and unknown actions", async () => {
    const lock = lockFromState();
    await expect(lock.fetch(claimRequest("", 60))).resolves.toMatchObject({ status: 400 });
    await expect(
      lock.fetch(
        new Request("https://submission-lock/claim", {
          method: "POST",
          body: JSON.stringify({ ownerToken: "x", ttlSeconds: 0 }),
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    // Non-string ownerToken / non-number ttlSeconds → empty / NaN → invalid_claim.
    await expect(
      lock.fetch(
        new Request("https://submission-lock/claim", {
          method: "POST",
          body: JSON.stringify({ ownerToken: 12, ttlSeconds: "60" }),
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(lock.fetch(new Request("https://submission-lock/claim", { method: "POST", body: "{" }))).resolves
      .toMatchObject({ status: 400 });
    await expect(lock.fetch(releaseRequest(""))).resolves.toMatchObject({ status: 400 });
    // Non-string release token hits the `typeof … === "string"` false arm.
    await expect(
      lock.fetch(
        new Request("https://submission-lock/release", {
          method: "POST",
          body: JSON.stringify({ ownerToken: false }),
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(lock.fetch(new Request("https://submission-lock/nope", { method: "POST", body: "{}" }))).resolves
      .toMatchObject({ status: 404 });
    // Empty pathname after strip → default action "claim".
    await expect(
      lock.fetch(
        new Request("https://submission-lock/", {
          method: "POST",
          body: JSON.stringify({ ownerToken: "token-default", ttlSeconds: 30 }),
        }),
      ).then((r) => r.json()),
    ).resolves.toEqual({ acquired: true });
  });

  it("reports released:false when nothing is held", async () => {
    const lock = lockFromState();
    await expect(lock.fetch(releaseRequest("orphan")).then((r) => r.json())).resolves.toEqual({
      released: false,
    });
  });

  it("treats a same-token re-claim as a refresh while the lock is still held", async () => {
    // existing.ownerToken === ownerToken arm: holder may refresh TTL without losing the claim.
    const lock = lockFromState();
    await expect(lock.fetch(claimRequest("token-a", 60)).then((r) => r.json())).resolves.toEqual({
      acquired: true,
    });
    await expect(lock.fetch(claimRequest("token-a", 120)).then((r) => r.json())).resolves.toEqual({
      acquired: true,
    });
  });
});

describe("claimTransientLock / releaseTransientLockIfOwner — cache fallback without SUBMISSION_LOCK (#8896)", () => {
  it("still uses the cache claim()/releaseIfValue path when the DO binding is absent", async () => {
    const claims: Array<{ key: string; value: string; ttl: number }> = [];
    const releases: Array<{ key: string; value: string }> = [];
    const held = new Map<string, string>();

    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async (key, value, ttlSeconds) => {
          claims.push({ key, value, ttl: ttlSeconds });
          if (held.has(key)) return false;
          held.set(key, value);
          return true;
        },
        releaseIfValue: async (key, value) => {
          releases.push({ key, value });
          if (held.get(key) !== value) return false;
          held.delete(key);
          return true;
        },
      },
    });
    delete env.SUBMISSION_LOCK;

    const first = await claimTransientLock(env, "cache-lock-key", 30);
    const second = await claimTransientLock(env, "cache-lock-key", 30);
    expect(first.acquired).toBe(true);
    expect(first.ownerToken).toEqual(expect.any(String));
    expect(second.acquired).toBe(false);
    expect(second.ownerToken).toBeNull();
    expect(claims).toHaveLength(2);

    await releaseTransientLockIfOwner(env, "cache-lock-key", first.ownerToken);
    expect(releases).toEqual([{ key: "cache-lock-key", value: first.ownerToken }]);

    const reclaim = await claimTransientLock(env, "cache-lock-key", 30);
    expect(reclaim.acquired).toBe(true);
  });

  it("fails open on DO transport errors without consulting the cache when the binding is present", async () => {
    let cacheClaimed = false;
    const env = createTestEnv({
      SUBMISSION_LOCK: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => {
            throw new Error("do unavailable");
          },
        }),
      } as unknown as DurableObjectNamespace,
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => {
          cacheClaimed = true;
          return true;
        },
        releaseIfValue: async () => true,
      },
    });

    const result = await claimTransientLock(env, "key", 10);
    expect(result).toEqual({ acquired: true, ownerToken: null });
    expect(cacheClaimed).toBe(false);
  });

  it("fails open when the DO returns a non-boolean acquired payload", async () => {
    const env = createTestEnv({
      SUBMISSION_LOCK: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({ acquired: "yes" }),
        }),
      } as unknown as DurableObjectNamespace,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;
    await expect(claimTransientLock(env, "key", 10)).resolves.toEqual({
      acquired: true,
      ownerToken: null,
    });
  });

  it("releases via the DO when bound and ignores a null owner token", async () => {
    const ns = submissionLockNamespace();
    const env = createTestEnv({
      SUBMISSION_LOCK: ns as unknown as DurableObjectNamespace,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;

    const claim = await claimTransientLock(env, "release-key", 60);
    expect(claim.acquired).toBe(true);
    await releaseTransientLockIfOwner(env, "release-key", null);
    expect(ns.releaseCalls).toBe(0);

    await releaseTransientLockIfOwner(env, "release-key", claim.ownerToken);
    expect(ns.releaseCalls).toBe(1);

    const reclaim = await claimTransientLock(env, "release-key", 60);
    expect(reclaim.acquired).toBe(true);
  });

  it("swallows DO release failures (TTL is the backstop)", async () => {
    const env = createTestEnv({
      SUBMISSION_LOCK: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => {
            throw new Error("release failed");
          },
        }),
      } as unknown as DurableObjectNamespace,
    });
    await expect(releaseTransientLockIfOwner(env, "key", "token")).resolves.toBeUndefined();
  });
});

describe("claimTransientLock — steal option (#9008)", () => {
  it("cache path: steal overwrites a still-live holder's claim instead of contending against it", async () => {
    const held = new Map<string, string>();
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async (key) => held.get(key) ?? null,
        set: async (key, value) => {
          held.set(key, value);
        },
        claim: async (key, value) => {
          if (held.has(key)) return false;
          held.set(key, value);
          return true;
        },
        releaseIfValue: async (key, value) => {
          if (held.get(key) !== value) return false;
          held.delete(key);
          return true;
        },
      },
    });
    delete env.SUBMISSION_LOCK;

    const original = await claimTransientLock(env, "steal-key", 30);
    expect(original.acquired).toBe(true);

    // A plain (non-steal) claim against the same key still contends normally and loses.
    const contended = await claimTransientLock(env, "steal-key", 30);
    expect(contended.acquired).toBe(false);

    const stolen = await claimTransientLock(env, "steal-key", 30, { steal: true });
    expect(stolen.acquired).toBe(true);
    expect(stolen.ownerToken).toEqual(expect.any(String));
    expect(stolen.ownerToken).not.toBe(original.ownerToken);
    expect(held.get("steal-key")).toBe(stolen.ownerToken);

    // The stealer's own token now genuinely owns the key: it releases cleanly...
    await releaseTransientLockIfOwner(env, "steal-key", stolen.ownerToken);
    expect(held.has("steal-key")).toBe(false);
    // ...and the ORIGINAL holder's stale release (its token no longer matches) is a safe no-op, exactly like
    // the existing stale-actuation-lock-holder regression above.
    held.set("steal-key", "someone-else");
    await releaseTransientLockIfOwner(env, "steal-key", original.ownerToken);
    expect(held.get("steal-key")).toBe("someone-else");
  });

  it("cache path: steal fails open (acquired: true, ownerToken: null) when the underlying set() throws", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => {
          throw new Error("cache unavailable");
        },
        claim: async () => true,
        releaseIfValue: async () => true,
      },
    });
    delete env.SUBMISSION_LOCK;

    await expect(claimTransientLock(env, "steal-key", 30, { steal: true })).resolves.toEqual({
      acquired: true,
      ownerToken: null,
    });
  });

  it("cache path: a non-steal call is byte-identical to before -- steal:false/absent never touches set()", async () => {
    let setCalls = 0;
    const held = new Map<string, string>();
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async (key) => held.get(key) ?? null,
        set: async (key, value) => {
          setCalls += 1;
          held.set(key, value);
        },
        claim: async (key, value) => {
          if (held.has(key)) return false;
          held.set(key, value);
          return true;
        },
        releaseIfValue: async () => true,
      },
    });
    delete env.SUBMISSION_LOCK;

    await claimTransientLock(env, "steal-key", 30);
    await claimTransientLock(env, "steal-key", 30, { steal: false });
    expect(setCalls).toBe(0);
  });

  it("DO path: steal overwrites a still-live claim; a non-steal claim against the same key still loses", async () => {
    const ns = submissionLockNamespace();
    const env = createTestEnv({ SUBMISSION_LOCK: ns as unknown as DurableObjectNamespace });
    delete env.SELFHOST_TRANSIENT_CACHE;

    const original = await claimTransientLock(env, "do-steal-key", 60);
    expect(original.acquired).toBe(true);

    const contended = await claimTransientLock(env, "do-steal-key", 60);
    expect(contended.acquired).toBe(false);

    const stolen = await claimTransientLock(env, "do-steal-key", 60, { steal: true });
    expect(stolen.acquired).toBe(true);
    expect(stolen.ownerToken).not.toBe(original.ownerToken);

    // The stealer's release now works; the original holder's own token no longer matches what's stored.
    await releaseTransientLockIfOwner(env, "do-steal-key", stolen.ownerToken);
    const reclaim = await claimTransientLock(env, "do-steal-key", 60);
    expect(reclaim.acquired).toBe(true);
  });
});

describe("domain wrappers + PrActuationLockContendedError (#8896)", () => {
  it("routes claim/release for PR actuation and contributor-cap through the same lock helpers", async () => {
    const ns = submissionLockNamespace();
    const env = createTestEnv({
      SUBMISSION_LOCK: ns as unknown as DurableObjectNamespace,
    });
    delete env.SELFHOST_TRANSIENT_CACHE;

    const pr = await claimPrActuationLock(env, "Acme/Widgets", 7);
    expect(pr.acquired).toBe(true);
    await releasePrActuationLock(env, "Acme/Widgets", 7, pr.ownerToken);

    const cap = await claimContributorCapLock(env, "Acme/Widgets", "Alice");
    expect(cap.acquired).toBe(true);
    await releaseContributorCapLock(env, "Acme/Widgets", "Alice", cap.ownerToken);
  });

  it("builds a fast-retry contended error with a distinct retryKind", () => {
    const error = new PrActuationLockContendedError("acme/widgets", 3, "maintenance");
    expect(error).toBeInstanceOf(PrActuationLockContendedError);
    expect(error.name).toBe("PrActuationLockContendedError");
    expect(error.message).toContain("acme/widgets#3");
    expect(error.message).toContain("maintenance");
    expect(error.retryAfterMs).toBe(5_000);
    expect(error.retryKind).toBe("pr_actuation_lock_contended");
  });
});

describe("claimTransientLock — the catch(cache.claim() throws) fail-open branch (#4013 step 1 gap close)", () => {
  it("fails OPEN when cache.claim() itself throws, even with releaseIfValue present (reaches the try/catch, not the earlier releaseIfValue guard)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => {
          throw new Error("redis unavailable");
        },
        releaseIfValue: async () => true,
      },
    });
    delete env.SUBMISSION_LOCK;
    const result = await claimTransientLock(env, "some-lock-key", 600);
    expect(result).toEqual({ acquired: true, ownerToken: null });
  });

  it("fails OPEN when the cache has no claim() primitive", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
      },
    });
    delete env.SUBMISSION_LOCK;
    await expect(claimTransientLock(env, "key", 10)).resolves.toEqual({
      acquired: true,
      ownerToken: null,
    });
  });

  it("fails OPEN when claim() exists without releaseIfValue (unreleasable lock shape)", async () => {
    let claimed = false;
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => {
          claimed = true;
          return true;
        },
      },
    });
    delete env.SUBMISSION_LOCK;
    await expect(claimTransientLock(env, "key", 10)).resolves.toEqual({
      acquired: true,
      ownerToken: null,
    });
    expect(claimed).toBe(false);
  });
});

describe("releaseTransientLockIfOwner — no-op when there's no releaseIfValue primitive to release against (#4013 step 1 gap close)", () => {
  it("no-ops (never throws) when SELFHOST_TRANSIENT_CACHE isn't configured at all, given a real owner token", async () => {
    const env = createTestEnv({});
    delete env.SELFHOST_TRANSIENT_CACHE;
    delete env.SUBMISSION_LOCK;
    await expect(releaseTransientLockIfOwner(env, "some-lock-key", "a-real-token")).resolves.toBeUndefined();
  });

  it("swallows cache releaseIfValue failures (TTL is the backstop)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => true,
        releaseIfValue: async () => {
          throw new Error("redis release failed");
        },
      },
    });
    delete env.SUBMISSION_LOCK;
    await expect(releaseTransientLockIfOwner(env, "key", "token")).resolves.toBeUndefined();
  });
});
