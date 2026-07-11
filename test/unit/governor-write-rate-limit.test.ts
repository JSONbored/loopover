import { describe, expect, it } from "vitest";
import {
  buildWriteRateLimitGovernorLedgerEvent,
  clearWriteRateLimitBackoff,
  evaluateWriteRateLimit,
  recordWriteRateLimitAllowed,
  recordWriteRateLimitDenied,
  writeRateLimitRepoKey,
  type WriteRateLimitBackoffStore,
  type WriteRateLimitBucketStore,
  type WriteRateLimitPolicies,
} from "../../packages/gittensory-engine/src/governor/write-rate-limit";

const ACTION = "open_pr";
const REPO_A = "acme/repo-a";
const REPO_B = "acme/repo-b";

const tightPolicies: WriteRateLimitPolicies = {
  global: { [ACTION]: { limit: 2, windowMs: 10_000 } },
  perRepo: { [ACTION]: { limit: 2, windowMs: 10_000 } },
  backoffBaseMs: 100,
};

function emptyState(nowMs: number): {
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
} {
  return {
    buckets: { global: {}, perRepo: {} },
    backoffAttempts: {},
  };
}

function attemptWrite(
  state: { buckets: WriteRateLimitBucketStore; backoffAttempts: WriteRateLimitBackoffStore },
  repoFullName: string,
  nowMs: number,
  policies: WriteRateLimitPolicies = tightPolicies,
  randomFn: () => number = () => 0.5,
) {
  const verdict = evaluateWriteRateLimit({
    actionClass: ACTION,
    repoFullName,
    buckets: state.buckets,
    backoffAttempts: state.backoffAttempts,
    policies,
    nowMs,
    randomFn,
  });
  if (verdict.allowed) {
    return {
      verdict,
      buckets: recordWriteRateLimitAllowed(state.buckets, ACTION, repoFullName, nowMs, policies),
      backoffAttempts: clearWriteRateLimitBackoff(state.backoffAttempts, ACTION, repoFullName),
    };
  }
  return {
    verdict,
    buckets: state.buckets,
    backoffAttempts: recordWriteRateLimitDenied(state.backoffAttempts, ACTION, repoFullName),
  };
}

describe("evaluateWriteRateLimit (#2344)", () => {
  it("allows a write when both global and per-repo buckets are under their limits", () => {
    const verdict = evaluateWriteRateLimit({
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: { global: {}, perRepo: {} },
      backoffAttempts: {},
      policies: tightPolicies,
      nowMs: 1_000,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("under_limit");
    expect(verdict.retryAfterMs).toBe(0);
  });

  it("throttles a burst past the per-repo limit and increments backoff attempts", () => {
    let state = emptyState(1_000);
    const outcomes: boolean[] = [];

    for (let i = 0; i < 4; i++) {
      const result = attemptWrite(state, REPO_A, 1_000 + i, tightPolicies, () => 0.5);
      state = result;
      outcomes.push(result.verdict.allowed);
    }

    expect(outcomes).toEqual([true, true, false, false]);
    expect(state.backoffAttempts[`${ACTION}:acme/repo-a`]).toBe(2);
  });

  it("uses increasing jitter when backoff attempts grow on repeated denials", () => {
    const blockedBuckets: WriteRateLimitBucketStore = {
      global: { [ACTION]: { count: 2, windowStartMs: 0 } },
      perRepo: { [`${ACTION}:acme/repo-a`]: { count: 2, windowStartMs: 0 } },
    };
    const baseInput = {
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: blockedBuckets,
      policies: { ...tightPolicies, backoffBaseMs: 500 },
      nowMs: 9_990,
      randomFn: () => 0.5,
    };

    const first = evaluateWriteRateLimit({ ...baseInput, backoffAttempts: {} });
    const second = evaluateWriteRateLimit({
      ...baseInput,
      backoffAttempts: { [`${ACTION}:acme/repo-a`]: 1 },
    });
    const third = evaluateWriteRateLimit({
      ...baseInput,
      backoffAttempts: { [`${ACTION}:acme/repo-a`]: 2 },
    });

    expect(first.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(first.retryAfterMs);
    expect(third.retryAfterMs).toBeGreaterThan(second.retryAfterMs);
  });

  it("blocks on the global ceiling even when every individual repo bucket is under its own limit", () => {
    let state = emptyState(1_000);
    expect(attemptWrite(state, REPO_A, 1_000).verdict.allowed).toBe(true);
    state = attemptWrite(state, REPO_A, 1_100);
    expect(attemptWrite(state, REPO_B, 1_200).verdict.allowed).toBe(true);
    state = attemptWrite(state, REPO_B, 1_300);
    const blocked = attemptWrite(state, REPO_A, 1_400);
    expect(blocked.verdict.allowed).toBe(false);
    expect(blocked.verdict.blockedBy).toBe("global");
    expect(blocked.verdict.reason).toBe("global_rate_limit");
  });

  it("resets buckets after the rolling window elapses", () => {
    let state = emptyState(0);
    state = attemptWrite(state, REPO_A, 0);
    state = attemptWrite(state, REPO_A, 100);
    const blocked = attemptWrite(state, REPO_A, 200);
    expect(blocked.verdict.allowed).toBe(false);

    const afterWindow = attemptWrite(state, REPO_A, 10_500);
    expect(afterWindow.verdict.allowed).toBe(true);
    expect(afterWindow.verdict.reason).toBe("under_limit");
  });

  it("buildWriteRateLimitGovernorLedgerEvent records throttle metadata for retries", () => {
    const verdict = evaluateWriteRateLimit({
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: {
        global: { [ACTION]: { count: 2, windowStartMs: 0 } },
        perRepo: { [`${ACTION}:acme/repo-a`]: { count: 0, windowStartMs: 0 } },
      },
      backoffAttempts: { [`${ACTION}:acme/repo-a`]: 1 },
      policies: tightPolicies,
      nowMs: 100,
      randomFn: () => 0.5,
    });
    expect(verdict.allowed).toBe(false);
    const event = buildWriteRateLimitGovernorLedgerEvent(REPO_A, ACTION, verdict);
    expect(event).toMatchObject({
      eventType: "throttled",
      actionClass: ACTION,
      decision: "throttle",
      reason: "global_rate_limit",
      payload: {
        blockedBy: "global",
        backoffAttempt: 1,
      },
    });
    expect(event.payload?.retryAfterMs).toBeGreaterThan(0);
  });

  it("buildWriteRateLimitGovernorLedgerEvent records an empty payload on allow", () => {
    const verdict = evaluateWriteRateLimit({
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: { global: {}, perRepo: {} },
      backoffAttempts: {},
      nowMs: 1,
    });
    const event = buildWriteRateLimitGovernorLedgerEvent(REPO_A, ACTION, verdict);
    expect(event).toMatchObject({
      eventType: "allowed",
      decision: "allow",
      reason: "under_limit",
      payload: {},
    });
  });

  it("blocks on the per-repo bucket when the global bucket still has capacity", () => {
    const policies: WriteRateLimitPolicies = {
      global: { [ACTION]: { limit: 10, windowMs: 10_000 } },
      perRepo: { [ACTION]: { limit: 1, windowMs: 10_000 } },
      backoffBaseMs: 100,
    };
    let state = emptyState(0);
    state = attemptWrite(state, REPO_A, 0, policies);
    const blocked = attemptWrite(state, REPO_A, 1, policies);
    expect(blocked.verdict.allowed).toBe(false);
    expect(blocked.verdict.blockedBy).toBe("per_repo");
    expect(blocked.verdict.reason).toBe("per_repo_rate_limit");
  });

  it("uses default policies and repo keys when callers omit optional config", () => {
    const key = writeRateLimitRepoKey(" open_pr ", " Acme/Repo-A ");
    expect(key).toBe("open_pr:acme/repo-a");

    const verdict = evaluateWriteRateLimit({
      actionClass: "unknown_action",
      repoFullName: REPO_A,
      buckets: { global: {}, perRepo: {} },
      backoffAttempts: {},
      nowMs: 1_000,
    });
    expect(verdict.allowed).toBe(true);

    const buckets = recordWriteRateLimitAllowed(
      { global: {}, perRepo: {} },
      ACTION,
      REPO_A,
      1_000,
    );
    expect(buckets.global[ACTION]?.count).toBe(1);
  });

  it("recordWriteRateLimitDenied increments and clearWriteRateLimitBackoff removes backoff keys", () => {
    expect(clearWriteRateLimitBackoff({}, ACTION, REPO_A)).toEqual({});

    const denied = recordWriteRateLimitDenied({}, ACTION, REPO_A);
    expect(denied[`${ACTION}:acme/repo-a`]).toBe(1);
    expect(clearWriteRateLimitBackoff(denied, ACTION, REPO_A)).toEqual({});
  });

  it("falls back to the default jitter draw when randomFn is omitted on a throttle", () => {
    const verdict = evaluateWriteRateLimit({
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: {
        global: { [ACTION]: { count: 2, windowStartMs: 0 } },
        perRepo: { [`${ACTION}:acme/repo-a`]: { count: 2, windowStartMs: 0 } },
      },
      backoffAttempts: {},
      policies: tightPolicies,
      nowMs: 9_990,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterMs).toBeGreaterThanOrEqual(100);
  });

  it("normalizes non-finite clock and bucket inputs when advancing counters", () => {
    const verdict = evaluateWriteRateLimit({
      actionClass: ACTION,
      repoFullName: REPO_A,
      buckets: { global: {}, perRepo: {} },
      backoffAttempts: {},
      policies: tightPolicies,
      nowMs: Number.NaN,
    });
    expect(verdict.allowed).toBe(true);

    const buckets = recordWriteRateLimitAllowed(
      {
        global: { [ACTION]: { count: 1, windowStartMs: Number.NaN } },
        perRepo: { [`${ACTION}:acme/repo-a`]: { count: 1, windowStartMs: 0 } },
      },
      ACTION,
      REPO_A,
      500,
      {
        global: { [ACTION]: { limit: 5, windowMs: Number.NaN } },
        perRepo: { [ACTION]: { limit: 5, windowMs: 10_000 } },
        backoffBaseMs: 100,
      },
    );
    expect(buckets.global[ACTION]?.count).toBe(1);
    expect(buckets.perRepo[`${ACTION}:acme/repo-a`]?.count).toBe(2);
  });
});
