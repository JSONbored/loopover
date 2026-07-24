import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as backfillModule from "../../src/github/backfill";
import {
  cachedLiveCiAggregate,
  cachedRequiredStatusContexts,
  observeRequiredContextsLookup,
  REQUIRED_CONTEXTS_UNRESOLVED_METRIC,
} from "../../src/queue/ci-resolution";
import type { LiveGithubFacts } from "../../src/queue/processors";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

function emptyFacts(): LiveGithubFacts {
  return {
    requiredContexts: new Map(),
    ciAggregates: new Map(),
    mergeStates: new Map(),
    forcedCiAggregateKeys: new Set(),
    forcedMergeStateKeys: new Set(),
  };
}

describe("cachedLiveCiAggregate request-scoped memoization (#4498)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the SAME in-flight/settled promise for a second call sharing the same facts + cache key, never fetching live twice", async () => {
    const env = createTestEnv();
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      advisoryHoldDetails: [],
      ciCompletenessWarning: null,
    });
    const facts = emptyFacts();
    const args = {
      repoFullName: "owner/repo",
      facts,
      prNumber: 7,
      headSha: "abc123",
      // null baseRef short-circuits fetchRequiredStatusContexts before any network call (see its own
      // `if (!baseRef) return null;` guard) -- irrelevant to what this test is verifying.
      baseRef: null,
      token: "tok",
      expectedCiContexts: null,
      advisoryCheckRuns: null,
    };

    const first = await cachedLiveCiAggregate(env, args);
    const second = await cachedLiveCiAggregate(env, args);

    expect(second).toEqual(first);
    expect(liveCiSpy).toHaveBeenCalledTimes(1);
  });

  it("#4372: a DIFFERENT advisoryCheckRuns config produces a DIFFERENT cache key, so the aggregate is re-fetched (a config change never serves a stale entry)", async () => {
    const env = createTestEnv();
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      advisoryHoldDetails: [],
      ciCompletenessWarning: null,
    });
    const facts = emptyFacts();
    const base = { repoFullName: "owner/repo", facts, prNumber: 7, headSha: "abc123", baseRef: null, token: "tok", expectedCiContexts: null };

    await cachedLiveCiAggregate(env, { ...base, advisoryCheckRuns: null });
    await cachedLiveCiAggregate(env, { ...base, advisoryCheckRuns: [{ name: "Third-Party Scan", appSlug: "example-scanner" }] });
    // Distinct advisory config ⇒ distinct key ⇒ two live fetches (not one memoized).
    expect(liveCiSpy).toHaveBeenCalledTimes(2);

    // The SAME advisory config in a different order still collapses to one key (order-independent fingerprint).
    const twoEntry = [{ name: "A", appSlug: "app-a" }, { name: "B", appSlug: "app-b" }];
    await cachedLiveCiAggregate(env, { ...base, advisoryCheckRuns: twoEntry });
    await cachedLiveCiAggregate(env, { ...base, advisoryCheckRuns: [...twoEntry].reverse() });
    expect(liveCiSpy).toHaveBeenCalledTimes(3); // +1 only, the reversed list reused the key
  });
});

describe("cachedRequiredStatusContexts resolved flag (#8358)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets resolved:false when the live branch-protection read fails (onFetchFailure fires) and keeps the expectedCiContexts config fallback", async () => {
    const env = createTestEnv();
    vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockImplementation(
      async (_env, _repo, _base, _token, _admission, onFetchFailure) => {
        // Real callers always pass onFetchFailure; the parameter is optional on the type, so call via ?.
        onFetchFailure?.(new Error("branch protection forbidden"));
        return null;
      },
    );
    const lookup = await cachedRequiredStatusContexts(env, "owner/repo", emptyFacts(), "main", "tok", ["lint"]);
    expect(lookup.resolved).toBe(false);
    expect(lookup.requiredContexts).toEqual(new Set(["lint"]));
  });

  it("sets resolved:true when the live branch-protection read succeeds", async () => {
    const env = createTestEnv();
    vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["ci"]));
    const lookup = await cachedRequiredStatusContexts(env, "owner/repo", emptyFacts(), "main", "tok", null);
    expect(lookup.resolved).toBe(true);
    expect(lookup.requiredContexts).toEqual(new Set(["ci"]));
  });
});

describe("observeRequiredContextsLookup (#8358)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a structured warn and increments the unresolved metric when resolved is false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observeRequiredContextsLookup(
      { requiredContexts: new Set(["lint"]), resolved: false },
      { repoFullName: "owner/repo", pullNumber: 9, baseRef: "main" },
    );
    expect(counterValue(REQUIRED_CONTEXTS_UNRESOLVED_METRIC)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      level: "warn",
      event: "required_contexts_branch_protection_unresolved",
      repoFullName: "owner/repo",
      pullNumber: 9,
      baseRef: "main",
    });
  });

  it("coalesces a nullish baseRef to null in the warn payload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observeRequiredContextsLookup(
      { requiredContexts: null, resolved: false },
      { repoFullName: "owner/repo", pullNumber: 3, baseRef: undefined },
    );
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ baseRef: null });
  });

  it("is a no-op when resolved is true (no metric, no warn)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observeRequiredContextsLookup(
      { requiredContexts: new Set(["ci"]), resolved: true },
      { repoFullName: "owner/repo", pullNumber: 9, baseRef: "main" },
    );
    expect(counterValue(REQUIRED_CONTEXTS_UNRESOLVED_METRIC)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
