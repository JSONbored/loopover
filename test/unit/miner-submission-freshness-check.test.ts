import { describe, expect, it, vi } from "vitest";

import { checkSubmissionFreshness, SUBMISSION_FRESHNESS_ABORT_EVENT } from "../../packages/gittensory-miner/lib/submission-freshness-check.js";

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
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "someone-else" }],
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
      referencingPrs: [{ number: 99, state: "merged" as const, authorLogin: "someone-else" }],
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
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "miner-bot" }],
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
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "Miner-Bot" }],
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
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: "SOMEONE-ELSE" }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: false, reason: "already_addressed" });
  });

  it("a referencing PR with a non-string authorLogin is ignored rather than crashing or false-flagging", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "open" as const, authorLogin: undefined as unknown as string }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("a CLOSED (not merged) referencing PR from another author does not count as already-addressed", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => ({
      state: "open" as const,
      referencingPrs: [{ number: 99, state: "closed" as const, authorLogin: "someone-else" }],
    }));

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
    );

    expect(result).toEqual({ fresh: true });
  });

  it("live-state-unavailable abort when the fetch returns null", async () => {
    const { claimLedger } = stubClaimLedger([activeClaim]);
    const { eventLedger } = stubEventLedger();
    const fetchLiveIssueSnapshot = vi.fn(async () => null);

    const result = await checkSubmissionFreshness(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner-bot" },
      { claimLedger, fetchLiveIssueSnapshot, eventLedger },
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
