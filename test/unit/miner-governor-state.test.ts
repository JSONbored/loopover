import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDefaultGovernorState, openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";

const roots: string[] = [];
const states: Array<{ close(): void }> = [];

function tempState() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  closeDefaultGovernorState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governor-state rate-limit state (#5134)", () => {
  it("defaults to empty buckets and backoff when nothing has been saved yet", () => {
    const state = tempState();
    expect(state.loadRateLimitState()).toEqual({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} });
  });

  it("round-trips saved buckets and backoff attempts", () => {
    const state = tempState();
    state.saveRateLimitState({
      buckets: { global: { open_pr: { count: 3, windowStartMs: 1000 } }, perRepo: {} },
      backoffAttempts: { "open_pr:acme/widgets": 2 },
    });
    expect(state.loadRateLimitState()).toEqual({
      buckets: { global: { open_pr: { count: 3, windowStartMs: 1000 } }, perRepo: {} },
      backoffAttempts: { "open_pr:acme/widgets": 2 },
    });
  });

  it("a second save overwrites the first (current-state semantics, not append)", () => {
    const state = tempState();
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 1, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 2, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    expect(state.loadRateLimitState().buckets.global.open_pr?.count).toBe(2);
  });

  it("saving rate-limit state preserves a previously saved cap usage in the same scalar row", () => {
    const state = tempState();
    state.saveCapUsage({ budgetSpent: 42, turnsTaken: 3, elapsedMs: 5000 });
    state.saveRateLimitState({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 42, turnsTaken: 3, elapsedMs: 5000 });
  });
});

describe("governor-state cap usage (#5134)", () => {
  it("defaults to zeroed usage when nothing has been saved yet", () => {
    const state = tempState();
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
  });

  it("round-trips saved cap usage and preserves a previously saved rate-limit state", () => {
    const state = tempState();
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 1, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    state.saveCapUsage({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });
    expect(state.loadRateLimitState().buckets.global.open_pr?.count).toBe(1);
  });
});

describe("governor-state reputation history (#5134)", () => {
  it("defaults to zero decided/unfavorable for a repo with no history", () => {
    const state = tempState();
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 0, unfavorable: 0 });
  });

  it("round-trips per-repo history independently", () => {
    const state = tempState();
    state.saveReputationHistory("acme/widgets", { decided: 10, unfavorable: 4 });
    state.saveReputationHistory("acme/gadgets", { decided: 2, unfavorable: 2 });
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 10, unfavorable: 4 });
    expect(state.loadReputationHistory("acme/gadgets")).toEqual({ decided: 2, unfavorable: 2 });
  });

  it("a second save overwrites (not accumulates) the prior row for the same repo", () => {
    const state = tempState();
    state.saveReputationHistory("acme/widgets", { decided: 1, unfavorable: 1 });
    state.saveReputationHistory("acme/widgets", { decided: 5, unfavorable: 1 });
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 5, unfavorable: 1 });
  });

  it("rejects a malformed repoFullName", () => {
    const state = tempState();
    expect(() => state.loadReputationHistory("not-a-repo")).toThrow(/invalid_repo_full_name/);
    expect(() => state.saveReputationHistory("not-a-repo", { decided: 1, unfavorable: 0 })).toThrow(/invalid_repo_full_name/);
  });
});

describe("governor-state own-submission history (#5134)", () => {
  it("records and lists submissions newest-first", () => {
    const state = tempState();
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fix auth bug", submittedAt: "2026-07-10T12:00:00Z", pullRequestNumber: 41 });
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fix login flow", submittedAt: "2026-07-11T12:00:00Z", pullRequestNumber: 42 });

    const all = state.listRecentOwnSubmissions();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({ repoFullName: "acme/widgets", fingerprint: "fix login flow", submittedAt: "2026-07-11T12:00:00Z", pullRequestNumber: 42, issueNumber: null });
    expect(all[1]?.fingerprint).toBe("fix auth bug");
  });

  it("filters by repoFullName", () => {
    const state = tempState();
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "a" });
    state.recordOwnSubmission({ repoFullName: "acme/gadgets", fingerprint: "b" });
    expect(state.listRecentOwnSubmissions({ repoFullName: "acme/gadgets" })).toHaveLength(1);
    expect(state.listRecentOwnSubmissions({ repoFullName: "acme/widgets" })[0]?.fingerprint).toBe("a");
  });

  it("respects a caller-supplied limit and defaults to 200", () => {
    const state = tempState();
    for (let i = 0; i < 5; i += 1) state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: `fp-${i}` });
    expect(state.listRecentOwnSubmissions({ limit: 2 })).toHaveLength(2);
    expect(state.listRecentOwnSubmissions()).toHaveLength(5);
  });

  it("defaults submittedAt to now and optional numbers to null when omitted", () => {
    const state = tempState();
    const before = Date.now();
    const recorded = state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fp" });
    expect(recorded.pullRequestNumber).toBeNull();
    expect(recorded.issueNumber).toBeNull();
    expect(Date.parse(recorded.submittedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("rejects a missing or blank fingerprint", () => {
    const state = tempState();
    expect(() => state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "" })).toThrow(/invalid_fingerprint/);
    expect(() => state.recordOwnSubmission({ repoFullName: "acme/widgets" } as never)).toThrow(/invalid_fingerprint/);
  });
});

describe("governor-state module-level default singleton (#5134)", () => {
  it("closeDefaultGovernorState is a safe no-op when nothing was ever opened", () => {
    expect(() => closeDefaultGovernorState()).not.toThrow();
  });
});
