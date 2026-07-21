import { describe, expect, it, vi } from "vitest";

import { checkSubmissionFreshness, SUBMISSION_FRESHNESS_ABORT_EVENT } from "../../packages/loopover-miner/lib/submission-freshness-check.js";

function stubClaimLedger(claims: Array<{ repoFullName: string; issueNumber: number; status: string }> = []) {
  const listClaims = vi.fn((filter: { repoFullName?: string; status?: string }) =>
    claims.filter((c) => (filter.repoFullName === undefined || c.repoFullName === filter.repoFullName) && (filter.status === undefined || c.status === filter.status)),
  );
  return { claimLedger: { listClaims }, listClaims };
}

function stubEventLedger() {
  const appendEvent = vi.fn((_event: { type: string; repoFullName?: string; payload: Record<string, unknown> }) => undefined);
  return { eventLedger: { appendEvent }, appendEvent };
}

const activeClaim = { repoFullName: "acme/widgets", issueNumber: 42, status: "active" };

describe("checkSubmissionFreshness (#3007)", () => {
  it("a fresh claim proceeds: active claim, open issue, no other-author referencing PRs", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
    expect(appendEvent).not.toHaveBeenCalled(); // only aborts get logged
  });

  it("claim-superseded abort: no claim ledger entry at all for this issue, without ever fetching live state", async () => {
    const { claimLedger } = stubClaimLedger([]); // no rows
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "claim_superseded" });
    expect(fetchLiveIssueSnapshot).not.toHaveBeenCalled(); // local, free check runs first
    expect(appendEvent).toHaveBeenCalledWith({
      type: SUBMISSION_FRESHNESS_ABORT_EVENT,
      repoFullName: "acme/widgets",
      payload: { issueNumber: 42, reason: "claim_superseded" },
    });
  });

  it("claim-superseded abort: a claim row exists but is released, not active", async () => {
    const { claimLedger } = stubClaimLedger([{ repoFullName: "acme/widgets", issueNumber: 42, status: "released" }]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "claim_superseded" });
    expect(fetchLiveIssueSnapshot).not.toHaveBeenCalled();
  });

  it("issue-closed abort", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "closed" as const, referencingPrs: [] }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "issue_closed" });
    expect(appendEvent).toHaveBeenCalledWith({
      type: SUBMISSION_FRESHNESS_ABORT_EVENT,
      repoFullName: "acme/widgets",
      payload: { issueNumber: 42, reason: "issue_closed" },
    });
  });

  it("already-addressed abort: an OPEN PR from another author already references the issue", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "someone-else", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("already-addressed abort: a MERGED PR from another author already references the issue", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "merged" as const, authorLogin: "someone-else", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("a referencing PR authored by the miner ITSELF does not count as already-addressed", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "miner-bot", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("a referencing PR authored by the miner's OWN login in a different case does not count as already-addressed", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "Miner-Bot", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("already-addressed abort still fires for a differently-cased OTHER author (case-insensitivity isn't a blanket bypass)", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "SOMEONE-ELSE", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("REGRESSION: a merged referencing PR with a missing authorLogin counts as already-addressed (fail-closed)", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "merged" as const, authorLogin: null as unknown as string, createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("a referencing PR with a non-string authorLogin counts as already-addressed instead of being ignored", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: undefined as unknown as string, createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("a CLOSED (not merged) referencing PR from another author does not count as already-addressed", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "closed" as const, authorLogin: "someone-else", createdAt: null }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("live-state-unavailable abort when the fetch returns null on every attempt", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => null);

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { sleepFn: async () => {}, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: false, reason: "live_state_unavailable" });
  });

  it("live-state-unavailable abort (fail closed) when the fetch throws, never treated as no-evidence-so-proceed", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { sleepFn: async () => {}, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: false, reason: "live_state_unavailable" });
  });

  it("tolerates a snapshot with no referencingPrs key at all (treated as empty, not a throw)", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const }) as never);

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("fails closed on a malformed candidate rather than silently proceeding", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));
    const deps = { claimLedger, fetchLiveIssueSnapshot, eventLedger };

    await expect(checkSubmissionFreshness(null as never, deps)).rejects.toThrow("invalid_freshness_candidate");
    await expect(checkSubmissionFreshness({ issueNumber: 42, minerLogin: "m" } as never, deps)).rejects.toThrow("invalid_repo_full_name");
    await expect(checkSubmissionFreshness({ repoFullName: "acme/widgets", minerLogin: "m" } as never, deps)).rejects.toThrow("invalid_issue_number");
    await expect(checkSubmissionFreshness({ repoFullName: "acme/widgets", issueNumber: 0, minerLogin: "m" }, deps)).rejects.toThrow("invalid_issue_number");
    await expect(checkSubmissionFreshness({ repoFullName: "acme/widgets", issueNumber: 42 } as never, deps)).rejects.toThrow("invalid_miner_login");
  });

  it("fails closed on malformed or missing dependencies", async () => {
    const candidate = { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" };
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));

    await expect(checkSubmissionFreshness(candidate, null as never)).rejects.toThrow("invalid_freshness_deps");
    await expect(checkSubmissionFreshness(candidate, { fetchLiveIssueSnapshot, eventLedger } as never)).rejects.toThrow("invalid_claim_ledger");
    await expect(checkSubmissionFreshness(candidate, { claimLedger, eventLedger } as never)).rejects.toThrow("invalid_live_state_fetcher");
    await expect(checkSubmissionFreshness(candidate, { claimLedger, fetchLiveIssueSnapshot } as never)).rejects.toThrow("invalid_event_ledger");
  });
});

describe("checkSubmissionFreshness live-state retry (#7089)", () => {
  it("rides out a thrown transient failure and proceeds on a later attempt instead of aborting", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    // First call: transient GitHub blip (a 5xx surfaces as a thrown fetch); second call: real snapshot.
    const fetchLiveIssueSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 5xx"))
      .mockResolvedValueOnce({ state: "open" as const, referencingPrs: [] });
    const sleeps: number[] = [];

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 3, sleepFn: async (ms: number) => { sleeps.push(ms); }, backoffMs: (attempt: number) => attempt * 100 },
    );

    expect(result).toEqual({ fresh: true });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([100]); // backed off once (after attempt 1) with backoffMs(1); no abort logged
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("rides out a null (non-object) snapshot and proceeds on a later attempt", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "open" as const, referencingPrs: [] });

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 3, sleepFn: async () => {}, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: true });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("stops the instant a real snapshot is obtained: does not burn remaining attempts or sleep", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));
    const sleepFn = vi.fn(async () => {});

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 3, sleepFn, backoffMs: (attempt: number) => attempt * 100 },
    );

    expect(result).toEqual({ fresh: true });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("still fails closed after the bounded retries are exhausted, appending the abort event exactly once", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => null); // never recovers
    const sleeps: number[] = [];

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 3, sleepFn: async (ms: number) => { sleeps.push(ms); }, backoffMs: (attempt: number) => attempt * 100 },
    );

    expect(result).toEqual({ fresh: false, reason: "live_state_unavailable" });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // backed off between attempts, never after the last
    expect(appendEvent).toHaveBeenCalledTimes(1); // logged once for the whole check, not once per failed attempt
    expect(appendEvent).toHaveBeenCalledWith({
      type: SUBMISSION_FRESHNESS_ABORT_EVENT,
      repoFullName: "acme/widgets",
      payload: { issueNumber: 42, reason: "live_state_unavailable" },
    });
  });

  it("does not retry a real staleness signal: a closed issue aborts on the first snapshot", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "closed" as const, referencingPrs: [] }));
    const sleepFn = vi.fn(async () => {});

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 3, sleepFn, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: false, reason: "issue_closed" });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(1); // a well-formed snapshot ends the retry loop
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("defaults maxAttempts/sleepFn/backoffMs when no options are passed (existing callers unchanged)", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger, appendEvent } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({ state: "open" as const, referencingPrs: [] }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(1); // succeeds first attempt, so no default backoff/sleep runs
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("uses the default (real) sleep between retries when no sleepFn is injected", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    // No sleepFn → exercises the default setTimeout-based sleep; backoffMs 0 keeps it instant.
    const fetchLiveIssueSnapshot = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "open" as const, referencingPrs: [] });

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 2, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: true });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
  });

  it("clamps a maxAttempts below 1 back to the default rather than skipping every attempt", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => null); // never recovers, so it runs the full default budget

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
      { maxAttempts: 0, sleepFn: async () => {}, backoffMs: () => 0 },
    );

    expect(result).toEqual({ fresh: false, reason: "live_state_unavailable" });
    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(3); // DEFAULT_SNAPSHOT_MAX_ATTEMPTS, not 0
  });
});
