import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMS_MIN_RANK_HARD_MAXIMUM,
  AMS_MIN_RANK_SHIPPED,
  applyMinRankOverride,
  backtestMinRankCandidate,
  buildAmsBacktestProposals,
  computeAmsBacktestTrackRecord,
  deriveTakenOpportunities,
  isValidMinRankOverride,
  MINER_AMS_MIN_RANK_APPLIED_EVENT,
  MINER_AMS_MIN_RANK_REVERTED_EVENT,
  MINER_AMS_THRESHOLD_BACKTEST_EVENT,
  readAmsThresholdBacktestRuns,
  readMinRankAutotuneEnabled,
  readMinRankOverride,
  recordAmsThresholdBacktestRun,
  revertMinRankOverride,
  type PersistedAmsBacktestRun,
} from "../../packages/loopover-miner/lib/ams-calibration.js";
import { initEventLedger, resolveEventLedgerDbPath, type EventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";

// #8184-#8187: the miner-side calibration seam. The engine replay math has its own suite
// (ams-rank-corpus-engine.test.ts); these tests pin the ledger join, run persistence + read-back, the
// track-record/proposals projections, and every arm of the double-gated min-rank override.

const tempDirs: string[] = [];
const ledgers: EventLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedger(): EventLedger {
  const dir = mkdtempSync(join(tmpdir(), "miner-ams-calibration-"));
  tempDirs.push(dir);
  const ledger = initEventLedger(resolveEventLedgerDbPath({ LOOPOVER_MINER_CONFIG_DIR: dir }));
  ledgers.push(ledger);
  return ledger;
}

function seedTake(ledger: EventLedger, issueNumber: number, rankScore: number, decision: "merged" | "closed"): void {
  ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber, rankScore, title: "t", labels: [] } });
  ledger.appendEvent({
    type: "pr_outcome",
    repoFullName: "acme/widgets",
    payload: { prNumber: 1000 + issueNumber, decision, closedAt: "2026-07-10T00:00:00Z", reason: null, issueNumber },
  });
}

function seedSkipFriendlyHistory(ledger: EventLedger): void {
  for (let i = 1; i <= 60; i += 1) seedTake(ledger, i, 0.15, "closed");
  seedTake(ledger, 101, 0.4, "merged");
  seedTake(ledger, 102, 0.4, "merged");
}

describe("deriveTakenOpportunities (#8184 ledger join)", () => {
  it("joins discovered_issue to pr_outcome by (repo, issueNumber); unpaired rows on either side never fabricate a take", () => {
    const ledger = tempLedger();
    seedTake(ledger, 7, 0.3, "closed");
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 8, rankScore: 0.9, title: "t", labels: [] } }); // no outcome
    ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 99, decision: "merged", closedAt: null, reason: null, issueNumber: 55 } }); // no rank
    ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 98, decision: "merged", closedAt: null, reason: null } }); // pre-pairing row: no issueNumber
    const takes = deriveTakenOpportunities(ledger.readEvents());
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ repoFullName: "acme/widgets", issueNumber: 7, rankScore: 0.3, realizedDecision: "closed", decidedAt: "2026-07-10T00:00:00Z" });
  });

  it("latest wins on BOTH sides: a re-discovery refreshes the rank, a later outcome supersedes (reopened-then-merged)", () => {
    const ledger = tempLedger();
    seedTake(ledger, 7, 0.3, "closed");
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 7, rankScore: 0.45, title: "t", labels: [] } });
    ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 1007, decision: "merged", closedAt: "2026-07-12T00:00:00Z", reason: null, issueNumber: 7 } });
    const takes = deriveTakenOpportunities(ledger.readEvents());
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ rankScore: 0.45, realizedDecision: "merged", decidedAt: "2026-07-12T00:00:00Z" });
  });

  it("tolerates malformed rows: non-object events, missing repo/payload, bad issueNumber/rankScore, foreign decisions", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 1.5, rankScore: 0.5 } });
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 2, rankScore: "high" } });
    ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 1, decision: "reopened", issueNumber: 2 } });
    expect(deriveTakenOpportunities([...ledger.readEvents(), null, 42, { type: "discovered_issue" }])).toEqual([]);
  });

  it("composes into the advisory backtest (backtestMinRankCandidate) end-to-end over a real ledger", () => {
    const ledger = tempLedger();
    seedSkipFriendlyHistory(ledger);
    const result = backtestMinRankCandidate(ledger.readEvents(), AMS_MIN_RANK_SHIPPED, 0.2);
    expect(result).not.toBeNull();
    expect(result!.visible.verdict).toBe("improved");
    expect(backtestMinRankCandidate([], AMS_MIN_RANK_SHIPPED, 0.2)).toBeNull(); // empty ledger: floors unmet
  });
});

describe("backtest-run persistence + projections (#8184/#8185/#8186)", () => {
  function persistedRun(ledger: EventLedger, candidate: number): PersistedAmsBacktestRun {
    const result = backtestMinRankCandidate(ledger.readEvents(), AMS_MIN_RANK_SHIPPED, candidate);
    expect(result).not.toBeNull();
    recordAmsThresholdBacktestRun(result!, { eventLedger: ledger });
    const runs = readAmsThresholdBacktestRuns(ledger);
    return runs[runs.length - 1]!;
  }

  it("round-trips a run event: full comparison metadata out equals what went in; corrupt/foreign rows are skipped", () => {
    const ledger = tempLedger();
    seedSkipFriendlyHistory(ledger);
    const run = persistedRun(ledger, 0.2);
    expect(run.candidateThreshold).toBe(0.2);
    expect(run.currentThreshold).toBe(AMS_MIN_RANK_SHIPPED);
    expect(run.visible.verdict).toBe("improved");
    expect(run.heldOut.verdict).toBe("improved");
    expect(run.visibleCases).toBeGreaterThan(0);
    // Corrupt rows: missing thresholds, malformed comparisons.
    ledger.appendEvent({ type: MINER_AMS_THRESHOLD_BACKTEST_EVENT, payload: { candidateThreshold: 0.3 } });
    ledger.appendEvent({ type: MINER_AMS_THRESHOLD_BACKTEST_EVENT, payload: { currentThreshold: 0, candidateThreshold: 0.3, visible: { ruleId: "x", verdict: "weird" }, heldOut: run.heldOut } });
    expect(readAmsThresholdBacktestRuns(ledger)).toHaveLength(1);
    expect(() => recordAmsThresholdBacktestRun(run as never, {})).toThrow("invalid_event_ledger");
  });

  it("track record (#8185): counts both slices per run via the shared engine aggregation; empty history is zero-run", () => {
    const ledger = tempLedger();
    seedSkipFriendlyHistory(ledger);
    persistedRun(ledger, 0.2);
    const record = computeAmsBacktestTrackRecord(readAmsThresholdBacktestRuns(ledger));
    expect(record.totalRuns).toBe(2); // visible + held-out comparisons
    expect(record.regressedRuns).toBe(0);
    expect(record.regressedRate).toBe(0);
    expect(computeAmsBacktestTrackRecord([]).totalRuns).toBe(0);
    expect(computeAmsBacktestTrackRecord([]).regressedRate).toBeNull();
  });

  it("proposals (#8186): latest run per candidate, cleared-only, stale/undatable excluded, deterministic order", () => {
    const ledger = tempLedger();
    seedSkipFriendlyHistory(ledger);
    const cleared = persistedRun(ledger, 0.2);
    const nowMs = Date.parse(cleared.createdAt ?? "") || Date.now();
    // A NOT-cleared run for another candidate (visible unchanged -- candidate equals current).
    const flat = backtestMinRankCandidate(ledger.readEvents(), 0.15, 0.15);
    if (flat) recordAmsThresholdBacktestRun(flat, { eventLedger: ledger });
    const runs = readAmsThresholdBacktestRuns(ledger);
    const proposals = buildAmsBacktestProposals(runs, nowMs + 1000);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ candidateThreshold: 0.2, visibleVerdict: "improved" });
    // Stale: everything outside the lookback drops out.
    expect(buildAmsBacktestProposals(runs, nowMs + 1000, 500)).toEqual([]);
    // Undatable rows never propose.
    expect(buildAmsBacktestProposals([{ ...runs[0]!, createdAt: null }], nowMs)).toEqual([]);
  });
});

describe("min-rank override: double-gated apply, gated read, revert (#8187)", () => {
  it("bounds check: strictly above shipped, at/below the hard maximum", () => {
    expect(isValidMinRankOverride(AMS_MIN_RANK_SHIPPED)).toBe(false);
    expect(isValidMinRankOverride(0.2)).toBe(true);
    expect(isValidMinRankOverride(AMS_MIN_RANK_HARD_MAXIMUM)).toBe(true);
    expect(isValidMinRankOverride(AMS_MIN_RANK_HARD_MAXIMUM + 0.01)).toBe(false);
    expect(isValidMinRankOverride("0.2")).toBe(false);
  });

  it("apply refuses in order -- flag_off, not_approved, out_of_bounds, no_supporting_run -- writing nothing", () => {
    const ledger = tempLedger();
    expect(applyMinRankOverride(0.2, { eventLedger: ledger, enabled: false, approved: true })).toEqual({ applied: false, reason: "flag_off" });
    expect(applyMinRankOverride(0.2, { eventLedger: ledger, enabled: true, approved: false })).toEqual({ applied: false, reason: "not_approved" });
    expect(applyMinRankOverride(0.9, { eventLedger: ledger, enabled: true, approved: true })).toEqual({ applied: false, reason: "out_of_bounds" });
    expect(applyMinRankOverride(0.2, { eventLedger: ledger, enabled: true, approved: true })).toEqual({ applied: false, reason: "no_supporting_run" });
    expect(readMinRankOverride(ledger, { enabled: true })).toBeNull();
    expect(() => applyMinRankOverride(0.2, { eventLedger: undefined as never, enabled: true, approved: true })).toThrow("invalid_event_ledger");
  });

  it("a cleared run + both gates applies; the read re-validates flag + bounds; revert restores shipped", () => {
    const ledger = tempLedger();
    seedSkipFriendlyHistory(ledger);
    const result = backtestMinRankCandidate(ledger.readEvents(), AMS_MIN_RANK_SHIPPED, 0.2)!;
    recordAmsThresholdBacktestRun(result, { eventLedger: ledger });

    const applied = applyMinRankOverride(0.2, { eventLedger: ledger, enabled: true, approved: true });
    expect(applied.applied).toBe(true);
    expect(readMinRankOverride(ledger, { enabled: true })).toBe(0.2);
    expect(readMinRankOverride(ledger, { enabled: false })).toBeNull(); // flag off => shipped, instantly

    // A hand-edited out-of-bounds applied row is ignored on read (bounds re-validate every read).
    ledger.appendEvent({ type: MINER_AMS_MIN_RANK_APPLIED_EVENT, payload: { value: 0.9 } });
    expect(readMinRankOverride(ledger, { enabled: true })).toBe(0.2);

    expect(revertMinRankOverride({ eventLedger: ledger, approved: false })).toEqual({ reverted: false, reason: "not_approved" });
    expect(revertMinRankOverride({ eventLedger: ledger, approved: true })).toEqual({ reverted: true });
    expect(readMinRankOverride(ledger, { enabled: true })).toBeNull();
    const reverts = ledger.readEvents().filter((e) => e.type === MINER_AMS_MIN_RANK_REVERTED_EVENT);
    expect(reverts).toHaveLength(1);
    expect(() => revertMinRankOverride({ eventLedger: undefined as never, approved: true })).toThrow("invalid_event_ledger");
  });
});

describe("readMinRankAutotuneEnabled (#8187 gate one)", () => {
  it("reads the flag from .loopover-ams.yml; missing file, parse-safe defaults, and thrown reads are all OFF", () => {
    const dir = mkdtempSync(join(tmpdir(), "miner-ams-policy-"));
    tempDirs.push(dir);
    const env = { LOOPOVER_MINER_CONFIG_DIR: dir };
    expect(readMinRankAutotuneEnabled(env)).toBe(false); // no file
    const path = join(dir, ".loopover-ams.yml");
    writeFileSync(path, "minRankAutotuneEnabled: true\n");
    expect(readMinRankAutotuneEnabled(env)).toBe(true);
    writeFileSync(path, "minRankAutotuneEnabled: banana\n");
    expect(readMinRankAutotuneEnabled(env)).toBe(false); // tolerant parser falls back to the OFF default
    expect(
      readMinRankAutotuneEnabled(env, {
        readFileSync: (() => {
          throw new Error("disk gone");
        }) as never,
      }),
    ).toBe(false); // fail CLOSED
  });
});
