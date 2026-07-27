import { describe, expect, it } from "vitest";
import { defaultRetryBackoffMs, fetchWithRetry } from "../../packages/loopover-miner/lib/http-retry";

const noSleep = () => Promise.resolve();

/** A fetchFn driven by a scripted list of behaviours: a number ⇒ a response with that status, "throw" ⇒ reject. */
function scriptedFetch(script: Array<number | "throw">) {
  let call = 0;
  const calls: unknown[] = [];
  const inits: Array<Record<string, unknown> | undefined> = [];
  const fn = async (url: unknown, init?: unknown) => {
    calls.push(url);
    inits.push(init as Record<string, unknown> | undefined);
    const step = script[Math.min(call, script.length - 1)] ?? 200;
    call += 1;
    if (step === "throw") throw new Error("network down");
    return { status: step };
  };
  return { fn, get calls() { return calls; }, get inits() { return inits; } };
}

describe("fetchWithRetry (#4829)", () => {
  it("returns a 2xx response on the first attempt with no retry", async () => {
    const f = scriptedFetch([200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("returns a 4xx immediately without retrying (client errors are not transient)", async () => {
    const f = scriptedFetch([404, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep });
    expect(res.status).toBe(404);
    expect(f.calls).toHaveLength(1);
  });

  it("retries a transient 5xx and returns the eventual success", async () => {
    const f = scriptedFetch([503, 500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 5, sleepFn: noSleep });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(3);
  });

  it("does NOT retry a thrown network error — it propagates immediately (poller #4281 contract)", async () => {
    const f = scriptedFetch(["throw", 200]);
    await expect(fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep })).rejects.toThrow("network down");
    expect(f.calls).toHaveLength(1); // no retry on a thrown error
  });

  it("returns the last 5xx response once attempts are exhausted (caller handles it)", async () => {
    const f = scriptedFetch([500]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(3);
  });

  it("makes exactly one attempt when maxAttempts is 1 (returns the 5xx, no retry)", async () => {
    const f = scriptedFetch([500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 1, sleepFn: noSleep });
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(1);
  });

  it("uses the built-in sleep + backoff when none are injected (0ms backoff keeps the test fast)", async () => {
    // No sleepFn and no backoffMs ⇒ exercises the default sleep (real setTimeout) with a 0ms delay, via a 5xx retry.
    const f = scriptedFetch([500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 2, backoffMs: () => 0 });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });

  it("sleeps the backoff between attempts and floors a bad maxAttempts to the default", async () => {
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const f = scriptedFetch([500]); // always 5xx ⇒ retries until the (default 3) attempts are used up
    // maxAttempts "0.5" floors to 0 ⇒ below 1 ⇒ falls back to the default of 3, so 2 sleeps happen.
    await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 0.5 as unknown as number, sleepFn, backoffMs: (a) => a * 10 });
    expect(f.calls).toHaveLength(3);
    expect(delays).toEqual([10, 20]);
  });
});

/** A response with case-insensitive header lookup, mirroring a real `Headers` object's `.get()`. */
function resp(status: number, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { status, headers: { get: (name: string) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) } };
}

/** A fetchFn driven by a scripted list of response objects (the last one repeats). */
function seqFetch(responses: Array<ReturnType<typeof resp>>) {
  let call = 0;
  return async (_url?: unknown, _init?: unknown) => responses[Math.min(call++, responses.length - 1)]!;
}

describe("fetchWithRetry rate-limit retry (#6761)", () => {
  it("retries a 429 (primary rate limit) and returns the eventual success", async () => {
    const f = seqFetch([resp(429), resp(200)]);
    const res = await fetchWithRetry(f, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(200);
  });

  it("retries a secondary-rate-limit 403 (Retry-After header present)", async () => {
    const f = seqFetch([resp(403, { "retry-after": "1" }), resp(200)]);
    const res = await fetchWithRetry(f, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(200);
  });

  it("retries a primary-rate-limit 403 (x-ratelimit-remaining: 0)", async () => {
    const f = seqFetch([resp(403, { "x-ratelimit-remaining": "0" }), resp(200)]);
    const res = await fetchWithRetry(f, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(200);
  });

  it("does NOT retry a plain permission 403 (no rate-limit signal) — returns it immediately", async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return resp(403, { "x-ratelimit-remaining": "4999" });
    };
    const res = await fetchWithRetry(f, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });

  it("does NOT retry a 403 with no headers at all (defensive header read)", async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return { status: 403 }; // no `headers` property
    };
    const res = await fetchWithRetry(f, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });

  it("honors Retry-After (delta-seconds), never below the backoff, and caps at MAX_BACKOFF_MS", async () => {
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    // attempt 1: Retry-After 2s > backoff 500 → 2000ms; attempt 2: Retry-After 3600s → capped to 10_000ms.
    const f = seqFetch([resp(429, { "retry-after": "2" }), resp(429, { "retry-after": "3600" }), resp(200)]);
    await fetchWithRetry(f, "u", undefined, { maxAttempts: 5, sleepFn, backoffMs: () => 500 });
    expect(delays).toEqual([2000, 10_000]);
  });

  it("falls back to the exponential backoff when Retry-After is smaller, zero, or non-numeric", async () => {
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    // Retry-After "0" → max(800, 0) = 800; "nope" → NaN → backoff 800.
    const f = seqFetch([resp(429, { "retry-after": "0" }), resp(429, { "retry-after": "nope" }), resp(200)]);
    await fetchWithRetry(f, "u", undefined, { maxAttempts: 5, sleepFn, backoffMs: () => 800 });
    expect(delays).toEqual([800, 800]);
  });
});

describe("fetchWithRetry timeoutMs (#miner-github-read-timeouts)", () => {
  it("does not inject a signal when timeoutMs is absent (undefined)", async () => {
    const f = scriptedFetch([200]);
    await fetchWithRetry(f.fn, "u", { method: "GET" }, { sleepFn: noSleep });
    expect(f.inits[0]?.signal).toBeUndefined();
  });

  it("does not inject a signal when timeoutMs is non-positive or non-finite", async () => {
    const f = scriptedFetch([200, 200, 200]);
    await fetchWithRetry(f.fn, "u", { method: "GET" }, { sleepFn: noSleep, timeoutMs: 0 });
    await fetchWithRetry(f.fn, "u", { method: "GET" }, { sleepFn: noSleep, timeoutMs: -5 });
    await fetchWithRetry(f.fn, "u", { method: "GET" }, { sleepFn: noSleep, timeoutMs: Number.NaN });
    expect(f.inits.map((i) => i?.signal)).toEqual([undefined, undefined, undefined]);
  });

  it("injects a fresh AbortSignal per attempt when timeoutMs is positive and finite, without losing the caller's own init fields", async () => {
    const f = scriptedFetch([500, 500, 200]);
    await fetchWithRetry(f.fn, "u", { method: "GET", headers: { a: "b" } }, { maxAttempts: 5, sleepFn: noSleep, timeoutMs: 5000 });
    expect(f.inits).toHaveLength(3);
    for (const init of f.inits) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ a: "b" });
    }
    // Each retry attempt gets its OWN fresh signal -- reusing one across attempts would leave every attempt
    // after the first pre-aborted the instant it fired once.
    expect(f.inits[0]?.signal).not.toBe(f.inits[1]?.signal);
    expect(f.inits[1]?.signal).not.toBe(f.inits[2]?.signal);
  });
});

describe("defaultRetryBackoffMs (#4829)", () => {
  it("grows exponentially from the base and caps", () => {
    expect(defaultRetryBackoffMs(1)).toBe(500);
    expect(defaultRetryBackoffMs(2)).toBe(1000);
    expect(defaultRetryBackoffMs(3)).toBe(2000);
    expect(defaultRetryBackoffMs(100)).toBe(10_000); // capped
    expect(defaultRetryBackoffMs(0)).toBe(500); // attempt clamped to >= 1
  });
});
