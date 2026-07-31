import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as backfillModule from "../../src/github/backfill";
import {
  cachedLiveCiAggregate,
  cachedRequiredStatusContexts,
  observeRequiredContextsLookup,
  refreshLiveCiAggregate,
  refreshLiveMergeState,
  REQUIRED_CONTEXTS_UNRESOLVED_METRIC,
  reuseOrRefreshLiveCiAggregate,
  setMergeStateUnknownRetryDelayMsForTest,
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

describe("refreshLiveMergeState retries a transient \"unknown\" read (#merge-race)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setMergeStateUnknownRetryDelayMsForTest(0);
  });

  it("REGRESSION: retries once and resolves to \"clean\" within the SAME pass when GitHub's first read is still computing", async () => {
    // metagraphed#8037 (live incident): an approved, gate-passing PR sat unmerged for ~6 minutes because the
    // one live mergeable_state read taken right after posting the review came back "unknown" (GitHub still
    // computing) and the disposition deferred to the next scheduled sweep. This proves the retry converts that
    // into an immediate same-pass resolution instead.
    const fetchSpy = vi
      .spyOn(backfillModule, "fetchLivePullRequestMergeState")
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("clean");
    const facts = emptyFacts();
    const result = await refreshLiveMergeState(createTestEnv(), "owner/repo", facts, 7, "tok");
    expect(result).toBe("clean");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry cap and still returns \"unknown\" (falls through to the next scheduled sweep, unchanged prior behavior)", async () => {
    const fetchSpy = vi.spyOn(backfillModule, "fetchLivePullRequestMergeState").mockResolvedValue("unknown");
    const facts = emptyFacts();
    const result = await refreshLiveMergeState(createTestEnv(), "owner/repo", facts, 7, "tok");
    expect(result).toBe("unknown");
    // 1 original + MAX_RETRIES(2) = 3 total attempts, never unbounded.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry a real, stable non-clean state (dirty) — only the transient 'still computing' value", async () => {
    const fetchSpy = vi.spyOn(backfillModule, "fetchLivePullRequestMergeState").mockResolvedValueOnce("dirty");
    const facts = emptyFacts();
    const result = await refreshLiveMergeState(createTestEnv(), "owner/repo", facts, 7, "tok");
    expect(result).toBe("dirty");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry an outright fetch failure (undefined) — best-effort, same as a stable state", async () => {
    const fetchSpy = vi.spyOn(backfillModule, "fetchLivePullRequestMergeState").mockResolvedValueOnce(undefined);
    const facts = emptyFacts();
    const result = await refreshLiveMergeState(createTestEnv(), "owner/repo", facts, 7, "tok");
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

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
      advisoryHoldDetails: [], ignoredCheckDetails: [],
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
      advisoryHoldDetails: [], ignoredCheckDetails: [],
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

describe("ignoredCheckRuns is threaded into the live CI aggregate, not just its cache key (#10018)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const IGNORED = [{ name: "Contributor trust", appSlug: "example-security-app" }];
  const okAggregate = {
    ciState: "passed" as const,
    hasPending: false,
    hasVisiblePending: false,
    hasMissingRequiredContext: false,
    failingDetails: [],
    nonRequiredFailingDetails: [],
    advisoryHoldDetails: [],
    ignoredCheckDetails: [],
    ciCompletenessWarning: null,
  };
  // Distinct headSha per call so the request-scoped memo never serves one test's aggregate to another.
  const base = (headSha: string) => ({
    repoFullName: "owner/repo",
    facts: emptyFacts(),
    prNumber: 7,
    headSha,
    baseRef: null,
    token: "tok",
    expectedCiContexts: null,
    advisoryCheckRuns: null,
  });
  // fetchLiveCiAggregatePreferGraphQl's 8th positional argument (index 7) is ignoredCheckRuns.
  const eighthArg = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls[0]?.[7];

  it("cachedLiveCiAggregate forwards the ignore list as the 8th positional argument", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue(okAggregate);
    await cachedLiveCiAggregate(env, { ...base("sha-cached"), ignoredCheckRuns: IGNORED });
    expect(eighthArg(spy)).toEqual(IGNORED);
  });

  it("refreshLiveCiAggregate forwards the ignore list as the 8th positional argument", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue(okAggregate);
    await refreshLiveCiAggregate(env, { ...base("sha-refresh"), ignoredCheckRuns: IGNORED });
    expect(eighthArg(spy)).toEqual(IGNORED);
  });

  it("reuseOrRefreshLiveCiAggregate (the positional-arg entry point) forwards the ignore list", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue(okAggregate);
    // reuseOrRefreshLiveCiAggregate is positional: ignoredCheckRuns is its 11th arg (after advisoryCheckRuns).
    await reuseOrRefreshLiveCiAggregate(env, "owner/repo", emptyFacts(), 7, "abc123", null, "tok", null, undefined, null, IGNORED);
    expect(eighthArg(spy)).toEqual(IGNORED);
  });

  it("REGRESSION #10018: an unconfigured repo (ignoredCheckRuns null) still passes null/undefined through — byte-identical", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue(okAggregate);
    await cachedLiveCiAggregate(env, { ...base("sha-null"), ignoredCheckRuns: null });
    expect(eighthArg(spy) ?? null).toBeNull(); // no ignore list configured ⇒ the arg is null/undefined
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
