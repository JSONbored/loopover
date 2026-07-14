import { afterEach, describe, expect, it, vi } from "vitest";
import * as backfillModule from "../../src/github/backfill";
import { cachedLiveCiAggregate } from "../../src/queue/ci-resolution";
import type { LiveGithubFacts } from "../../src/queue/processors";
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
    };

    const first = await cachedLiveCiAggregate(env, args);
    const second = await cachedLiveCiAggregate(env, args);

    expect(second).toEqual(first);
    expect(liveCiSpy).toHaveBeenCalledTimes(1);
  });
});
