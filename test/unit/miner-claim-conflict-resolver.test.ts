import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { assembleCompetingClaims, resolveClaimConflict } from "../../packages/loopover-miner/lib/claim-conflict-resolver";

function snapshot(referencingPrs: Array<{ number: number; state: "open" | "closed" | "merged"; authorLogin: string; createdAt: string | null }>) {
  return { state: "open" as const, referencingPrs };
}

describe("assembleCompetingClaims (#4848)", () => {
  it("keeps only OTHER open PRs, mapping createdAt -> claimedAt", () => {
    const competing = assembleCompetingClaims(
      snapshot([
        { number: 5, state: "open", authorLogin: "alice", createdAt: "2026-01-01T00:00:00Z" },
        { number: 6, state: "closed", authorLogin: "bob", createdAt: "2026-01-02T00:00:00Z" },
      ]),
      7,
      "miner-bot",
    );
    expect(competing).toEqual([{ number: 5, claimedAt: "2026-01-01T00:00:00Z" }]);
  });

  it("excludes self by PR number even if it somehow appears in the snapshot", () => {
    const competing = assembleCompetingClaims(
      snapshot([{ number: 7, state: "open", authorLogin: "miner-bot", createdAt: "2026-01-01T00:00:00Z" }]),
      7,
      "miner-bot",
    );
    expect(competing).toEqual([]);
  });

  it("excludes any other open PR authored by the SAME miner login, case-insensitively", () => {
    const competing = assembleCompetingClaims(
      snapshot([{ number: 9, state: "open", authorLogin: "Miner-Bot", createdAt: "2026-01-01T00:00:00Z" }]),
      7,
      "miner-bot",
    );
    expect(competing).toEqual([]);
  });

  it("returns an empty set for a null/undefined snapshot or a missing referencingPrs array", () => {
    expect(assembleCompetingClaims(null, 7, "miner-bot")).toEqual([]);
    expect(assembleCompetingClaims(undefined, 7, "miner-bot")).toEqual([]);
    expect(assembleCompetingClaims({ state: "open", referencingPrs: undefined as never }, 7, "miner-bot")).toEqual([]);
  });
});

describe("resolveClaimConflict (#4848)", () => {
  it("REGRESSION: two simulated competing claims are correctly adjudicated -- this miner WINS (claimed earliest) and its PR is never touched", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () =>
      snapshot([{ number: 6, state: "open", authorLogin: "someone-else", createdAt: "2026-01-02T00:00:00Z" }]),
    );
    const executeLocalWrite = vi.fn();

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
    );

    expect(result).toEqual({ checked: true, isWinner: true, winnerNumber: 5, competingCount: 1 });
    expect(executeLocalWrite).not.toHaveBeenCalled();
  });

  it("REGRESSION: two simulated competing claims are correctly adjudicated -- this miner LOSES and its own PR is closed with a real close_pr write citing the winner", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () =>
      snapshot([{ number: 5, state: "open", authorLogin: "someone-else", createdAt: "2026-01-01T00:00:00Z" }]),
    );
    const executeLocalWrite = vi.fn(async (spec: { action: string; command: string }) => ({ action: spec.action, code: 0, stdout: "", stderr: "", timedOut: false }));

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 6, selfClaimedAt: "2026-01-02T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
    );

    expect(result.checked).toBe(true);
    if (!result.checked) throw new Error("expected checked");
    expect(result.isWinner).toBe(false);
    expect(result.winnerNumber).toBe(5);
    expect(result.competingCount).toBe(1);

    expect(executeLocalWrite).toHaveBeenCalledTimes(1);
    const [spec] = executeLocalWrite.mock.calls[0]!;
    expect(spec.action).toBe("close_pr");
    expect(spec.command).toContain("gh pr close 6 --repo 'acme/widgets'");
    expect(spec.command).toContain("#5");
    expect((result as { closeResult: unknown }).closeResult).toEqual({ action: "close_pr", code: 0, stdout: "", stderr: "", timedOut: false });
  });

  it("no competing claims at all: trivial win, no live-write dependency invoked", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => snapshot([]));
    const executeLocalWrite = vi.fn();

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { sleepFn: async () => {} },
    );

    expect(result).toEqual({ checked: true, isWinner: true, winnerNumber: 5, competingCount: 0 });
    expect(executeLocalWrite).not.toHaveBeenCalled();
  });

  it("fails OPEN (never closes anything) when the live snapshot can't be fetched", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => null);
    const executeLocalWrite = vi.fn();

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { sleepFn: async () => {} },
    );

    expect(result).toEqual({ checked: false, reason: "live_state_unavailable" });
    expect(executeLocalWrite).not.toHaveBeenCalled();
  });

  it("fails OPEN when the live snapshot fetch throws", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => {
      throw new Error("network down");
    });
    const executeLocalWrite = vi.fn();

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { sleepFn: async () => {} },
    );

    expect(result).toEqual({ checked: false, reason: "live_state_unavailable" });
    expect(executeLocalWrite).not.toHaveBeenCalled();
  });

  it("builds a generic comment (no winner number) when the adjudicator can't determine a display winner", async () => {
    // BOTH sides sparse (no claim time on either side) -- fail-closed: this miner loses, but the winner is
    // not determinable either (mirrors miner-claim-adjudication.test.ts's own fail-closed/sparse case).
    const fetchLiveIssueSnapshot = vi.fn(async () => snapshot([{ number: 5, state: "open", authorLogin: "someone-else", createdAt: null }]));
    const executeLocalWrite = vi.fn(async (spec: { action: string; command: string }) => ({ action: spec.action, code: 0, stdout: "", stderr: "", timedOut: false }));

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 6, selfClaimedAt: null, minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
    );

    expect(result.checked).toBe(true);
    if (!result.checked) throw new Error("expected checked");
    expect(result.isWinner).toBe(false);
    expect(result.winnerNumber).toBeNull();
    const [spec] = executeLocalWrite.mock.calls[0]!;
    expect(spec.command).not.toContain("#null");
    expect(spec.command).toContain("another open pull request already claims this issue");
  });

  it("retries with backoff and detects a competitor that only propagates on a later attempt (#6058)", async () => {
    const competitor = snapshot([{ number: 5, state: "open", authorLogin: "someone-else", createdAt: "2026-01-01T00:00:00Z" }]);
    // First check: GitHub's index hasn't surfaced the competing PR yet; second check (after backoff): it has.
    const fetchLiveIssueSnapshot = vi.fn().mockResolvedValueOnce(snapshot([])).mockResolvedValueOnce(competitor);
    const executeLocalWrite = vi.fn(async (spec: { action: string; command: string }) => ({ action: spec.action, code: 0, stdout: "", stderr: "", timedOut: false }));
    const sleeps: number[] = [];

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 6, selfClaimedAt: "2026-01-02T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { sleepFn: async (ms: number) => { sleeps.push(ms); }, backoffMs: (attempt: number) => attempt * 100 },
    );

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([100]); // backed off once (after attempt 1) with backoffMs(1)
    expect(result.checked).toBe(true);
    if (!result.checked) throw new Error("expected checked");
    expect(result.isWinner).toBe(false);
    expect(result.competingCount).toBe(1);
    expect(executeLocalWrite).toHaveBeenCalledTimes(1);
  });

  it("stops early (no extra fetch or sleep) once a competitor is observed on the first attempt (#6058)", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => snapshot([{ number: 5, state: "open", authorLogin: "someone-else", createdAt: "2026-01-01T00:00:00Z" }]));
    const executeLocalWrite = vi.fn(async (spec: { action: string; command: string }) => ({ action: spec.action, code: 0, stdout: "", stderr: "", timedOut: false }));
    const sleepFn = vi.fn(async () => {});

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 6, selfClaimedAt: "2026-01-02T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { sleepFn },
    );

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(result.checked).toBe(true);
    if (!result.checked) throw new Error("expected checked");
    expect(result.isWinner).toBe(false);
  });

  it("exhausts the configured maxAttempts (backoff between each, never after the last) before declaring a winner (#6058)", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => snapshot([])); // no competitor ever appears
    const executeLocalWrite = vi.fn();
    const backoffAttempts: number[] = [];

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { maxAttempts: 4, sleepFn: async () => {}, backoffMs: (attempt: number) => { backoffAttempts.push(attempt); return 0; } },
    );

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(4);
    expect(backoffAttempts).toEqual([1, 2, 3]); // 3 gaps between 4 attempts, none after the last
    expect(result).toEqual({ checked: true, isWinner: true, winnerNumber: 5, competingCount: 0 });
    expect(executeLocalWrite).not.toHaveBeenCalled();
  });

  it("retries a transient fetch failure and uses the first snapshot that comes back (#6058)", async () => {
    const fetchLiveIssueSnapshot = vi.fn().mockRejectedValueOnce(new Error("index lag")).mockResolvedValueOnce(snapshot([]));
    const executeLocalWrite = vi.fn();

    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { maxAttempts: 2, sleepFn: async () => {} },
    );

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: true, isWinner: true, winnerNumber: 5, competingCount: 0 });
  });

  it("uses the default (real) sleep between retries when no sleepFn is injected (#6058)", async () => {
    const fetchLiveIssueSnapshot = vi.fn(async () => snapshot([]));
    const executeLocalWrite = vi.fn();
    // No sleepFn → exercises the default setTimeout-based sleep; backoffMs 0 keeps it instant.
    const result = await resolveClaimConflict(
      { repoFullName: "acme/widgets", issueNumber: 42, selfPrNumber: 5, selfClaimedAt: "2026-01-01T00:00:00Z", minerLogin: "miner-bot" },
      { fetchLiveIssueSnapshot, executeLocalWrite },
      { maxAttempts: 2, backoffMs: () => 0 },
    );

    expect(fetchLiveIssueSnapshot).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: true, isWinner: true, winnerNumber: 5, competingCount: 0 });
  });
});
