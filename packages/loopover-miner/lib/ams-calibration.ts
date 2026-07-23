// AMS calibration loop over the miner's own event ledger (#8184/#8185/#8186/#8187, epic #8172) -- the
// miner-side transposition of ORB's backtest loop, reusing the engine primitives untouched. This module is
// the ledger seam: derive taken opportunities (a `discovered_issue` rank record joined to the miner's own
// `pr_outcome` for the issue's PR -- the pairing #8184 added to the outcome payload), persist advisory
// backtest runs as typed events, aggregate their REGRESSED-verdict track record (#8185), project current
// backtest-cleared proposals for the status surface (#8186), and hold the DOUBLE-GATED min-rank override
// (#8187: the `.loopover-ams.yml` `minRankAutotuneEnabled` flag AND a per-apply `--approve`, loosening
// nothing by itself -- every consumer resolves the value through readMinRankOverride, which validates the
// hard bounds on every read so a corrupted ledger row can never move the knob past safety).
//
// Same layering as pr-outcome.ts: typed event constants + inject-ledger record/read helpers over the
// generic append-only event-ledger.js. Everything here is local-node-only.

import {
  AMS_MIN_RANK_RULE_ID,
  buildAmsRankCorpus,
  runAmsMinRankBacktest,
  type AmsMinRankBacktestResult,
  type AmsTakenOpportunity,
  type BacktestComparison,
  computeRegressedVerdictTrackRecord,
  type RegressedVerdictTrackRecord,
} from "@loopover/engine";
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { parseAmsPolicySpecContent } from "@loopover/engine";
import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";
import { resolveAmsPolicyConfigPath } from "./ams-policy.js";
import { MINER_PR_OUTCOME_EVENT } from "./pr-outcome.js";

/** Event-ledger vocabulary for one persisted advisory min-rank backtest run (the AMS analog of ORB's
 *  `calibration.threshold_backtest_run` -- the #8185 track record aggregates over these). */
export const MINER_AMS_THRESHOLD_BACKTEST_EVENT = "ams_threshold_backtest_run";
/** Event-ledger vocabulary for an approved min-rank override apply (#8187). */
export const MINER_AMS_MIN_RANK_APPLIED_EVENT = "ams_min_rank_override_applied";
/** Event-ledger vocabulary for a min-rank override reversion (#8187's one-command revert). */
export const MINER_AMS_MIN_RANK_REVERTED_EVENT = "ams_min_rank_override_reverted";

/** The shipped min-rank skip threshold: portfolio-discovery's normalizeMinRankScore default (0 -- nothing
 *  skipped). Declared here, next to the hard bound, per the #8121 discipline. */
export const AMS_MIN_RANK_SHIPPED = 0;
/** No evidence, however good, may raise the skip floor past this -- above it the miner would starve. */
export const AMS_MIN_RANK_HARD_MAXIMUM = 0.5;
/** Proposals older than this are stale and drop out of the status projection (#8186). */
export const AMS_BACKTEST_PROPOSAL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

type LedgerReader = { readEvents(filter?: { since?: number | null; repoFullName?: string | null }): unknown[] };
type LedgerWriter = { appendEvent(event: AppendEventInput): LedgerEntry };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readAll(eventLedger: LedgerReader): Array<Record<string, unknown>> {
  const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents() : [];
  return (Array.isArray(events) ? events : []).filter(
    (event): event is Record<string, unknown> => !!event && typeof event === "object",
  );
}

/**
 * PURE: join `discovered_issue` rank records to the miner's own `pr_outcome` events (#8184). The pairing
 * key is (repoFullName, issueNumber) -- outcome rows carry `issueNumber` since this issue's capture-time
 * addition; older rows without it simply never join (no fabricated pairs). Latest rank per issue wins
 * (re-discovery refreshes the score); latest outcome per issue wins (a reopened-then-merged PR settles on
 * its final decision, the same latest-wins discipline as calibration-cli's outcome reduction).
 */
export function deriveTakenOpportunities(events: readonly unknown[]): AmsTakenOpportunity[] {
  const ranks = new Map<string, { rankScore: number; discoveredAt: string }>();
  const outcomes = new Map<string, { decision: "merged" | "closed"; decidedAt: string; seq: number }>();
  for (const event of Array.isArray(events) ? events : []) {
    const record = event as Record<string, unknown> | null | undefined;
    if (!record || typeof record !== "object") continue;
    const repoFullName = typeof record.repoFullName === "string" ? record.repoFullName : null;
    const payload = record.payload as Record<string, unknown> | null | undefined;
    if (!repoFullName || !payload || typeof payload !== "object") continue;
    if (record.type === "discovered_issue") {
      if (!Number.isInteger(payload.issueNumber) || !isFiniteNumber(payload.rankScore)) continue;
      // Ledger order is append order -- a later discovery overwrites, so the newest rank wins.
      ranks.set(`${repoFullName}#${payload.issueNumber}`, {
        rankScore: payload.rankScore,
        discoveredAt: typeof record.createdAt === "string" ? record.createdAt : "",
      });
    } else if (record.type === MINER_PR_OUTCOME_EVENT) {
      if (!Number.isInteger(payload.issueNumber)) continue; // pre-pairing rows cannot join
      const decision = payload.decision;
      if (decision !== "merged" && decision !== "closed") continue;
      const key = `${repoFullName}#${payload.issueNumber}`;
      const seq = Number.isInteger(record.seq) ? (record.seq as number) : 0;
      const prior = outcomes.get(key);
      if (prior && prior.seq > seq) continue;
      outcomes.set(key, {
        decision,
        decidedAt:
          typeof payload.closedAt === "string" && payload.closedAt
            ? payload.closedAt
            : typeof record.createdAt === "string"
              ? record.createdAt
              : "",
        seq,
      });
    }
  }
  const takes: AmsTakenOpportunity[] = [];
  for (const [key, outcome] of outcomes) {
    const rank = ranks.get(key);
    if (!rank) continue;
    const separator = key.lastIndexOf("#");
    takes.push({
      repoFullName: key.slice(0, separator),
      issueNumber: Number(key.slice(separator + 1)),
      rankScore: rank.rankScore,
      realizedDecision: outcome.decision,
      discoveredAt: rank.discoveredAt,
      decidedAt: outcome.decidedAt,
    });
  }
  takes.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName) || a.issueNumber - b.issueNumber);
  return takes;
}

/** Convenience composition: ledger events -> taken opportunities -> replay corpus -> advisory result. */
export function backtestMinRankCandidate(
  events: readonly unknown[],
  currentThreshold: number,
  candidateThreshold: number,
): AmsMinRankBacktestResult | null {
  return runAmsMinRankBacktest(buildAmsRankCorpus(deriveTakenOpportunities(events)), currentThreshold, candidateThreshold);
}

/** Persist one advisory backtest run (#8184's third deliverable): the full comparison metadata, same shape
 *  ORB persists, so #8185's aggregation is byte-compatible with `computeRegressedVerdictTrackRecord`. */
export function recordAmsThresholdBacktestRun(result: AmsMinRankBacktestResult, options: { eventLedger?: LedgerWriter } = {}): LedgerEntry {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  return eventLedger.appendEvent({
    type: MINER_AMS_THRESHOLD_BACKTEST_EVENT,
    payload: {
      ruleId: result.ruleId,
      currentThreshold: result.currentThreshold,
      candidateThreshold: result.candidateThreshold,
      visibleCases: result.visibleCases,
      heldOutCases: result.heldOutCases,
      visible: result.visible as unknown as Record<string, unknown>,
      heldOut: result.heldOut as unknown as Record<string, unknown>,
    },
  });
}

export type PersistedAmsBacktestRun = {
  createdAt: string | null;
  currentThreshold: number;
  candidateThreshold: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

function isComparison(value: unknown): value is BacktestComparison {
  const record = value as Record<string, unknown> | null | undefined;
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.ruleId === "string" &&
    (record.verdict === "improved" || record.verdict === "regressed" || record.verdict === "unchanged")
  );
}

/** Read every persisted backtest run, oldest first; foreign types and malformed payloads are skipped (the
 *  pr-outcome read discipline -- a corrupt row can neither be written nor read back). */
export function readAmsThresholdBacktestRuns(eventLedger: LedgerReader): PersistedAmsBacktestRun[] {
  const runs: PersistedAmsBacktestRun[] = [];
  for (const record of readAll(eventLedger)) {
    if (record.type !== MINER_AMS_THRESHOLD_BACKTEST_EVENT) continue;
    const payload = record.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") continue;
    if (!isFiniteNumber(payload.currentThreshold) || !isFiniteNumber(payload.candidateThreshold)) continue;
    if (!isComparison(payload.visible) || !isComparison(payload.heldOut)) continue;
    runs.push({
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      currentThreshold: payload.currentThreshold,
      candidateThreshold: payload.candidateThreshold,
      visibleCases: Number.isInteger(payload.visibleCases) ? (payload.visibleCases as number) : 0,
      heldOutCases: Number.isInteger(payload.heldOutCases) ? (payload.heldOutCases as number) : 0,
      visible: payload.visible,
      heldOut: payload.heldOut,
    });
  }
  return runs;
}

/** #8185: the REGRESSED-verdict track record over every persisted run's comparisons -- the SAME aggregation
 *  ORB uses (`computeRegressedVerdictTrackRecord`), zero new math. Both slices count: a held-out REGRESSED
 *  is exactly as real a verdict as a visible one. */
export function computeAmsBacktestTrackRecord(runs: readonly PersistedAmsBacktestRun[]): RegressedVerdictTrackRecord {
  return computeRegressedVerdictTrackRecord(runs.flatMap((run) => [run.visible, run.heldOut]));
}

export type AmsBacktestProposal = {
  candidateThreshold: number;
  currentThreshold: number;
  visibleCases: number;
  heldOutCases: number;
  visibleVerdict: string;
  heldOutVerdict: string;
  at: string | null;
};

/** #8186: the current backtest-CLEARED proposals -- latest run per candidate inside the lookback whose
 *  visible slice is strictly `improved` and whose held-out slice is non-`regressed` (the Pareto discipline
 *  the run was scored under). Deterministic order (candidate ascending), bounded by construction (one per
 *  candidate). Display-only: nothing here applies anything. */
export function buildAmsBacktestProposals(
  runs: readonly PersistedAmsBacktestRun[],
  nowMs: number,
  lookbackMs: number = AMS_BACKTEST_PROPOSAL_LOOKBACK_MS,
): AmsBacktestProposal[] {
  const latest = new Map<number, PersistedAmsBacktestRun>();
  for (const run of runs) {
    const at = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
    if (!Number.isFinite(at) || nowMs - at > lookbackMs) continue; // stale or undatable runs never propose
    latest.set(run.candidateThreshold, run); // ledger order is append order -- the newest run wins
  }
  const proposals: AmsBacktestProposal[] = [];
  for (const run of latest.values()) {
    if (run.visible.verdict !== "improved" || run.heldOut.verdict === "regressed") continue;
    proposals.push({
      candidateThreshold: run.candidateThreshold,
      currentThreshold: run.currentThreshold,
      visibleCases: run.visibleCases,
      heldOutCases: run.heldOutCases,
      visibleVerdict: run.visible.verdict,
      heldOutVerdict: run.heldOut.verdict,
      at: run.createdAt,
    });
  }
  proposals.sort((a, b) => a.candidateThreshold - b.candidateThreshold);
  return proposals;
}

/** Sync read of the operator's `.loopover-ams.yml` `minRankAutotuneEnabled` flag (#8187's gate one). The
 *  async resolveAmsPolicy wrapper exists for attempt-time policy; the calibration commands and discover's
 *  consumption point need only this one boolean and must stay synchronous, so this reuses the same path
 *  resolution + tolerant parser. Fail CLOSED: an unreadable policy file never enables autonomy. */
export function readMinRankAutotuneEnabled(
  env: Record<string, string | undefined>,
  deps: { readFileSync?: typeof fsReadFileSync; existsSync?: typeof fsExistsSync } = {},
): boolean {
  try {
    const path = resolveAmsPolicyConfigPath(env);
    const exists = deps.existsSync ?? fsExistsSync;
    if (!exists(path)) return false;
    const read = deps.readFileSync ?? fsReadFileSync;
    return parseAmsPolicySpecContent(String(read(path, "utf8"))).spec.minRankAutotuneEnabled;
  } catch {
    return false;
  }
}

/** Bounds check shared by the apply path and every read: strictly above shipped (a "raise" to shipped is
 *  meaningless), at/below the hard maximum. */
export function isValidMinRankOverride(value: unknown): value is number {
  return isFiniteNumber(value) && value > AMS_MIN_RANK_SHIPPED && value <= AMS_MIN_RANK_HARD_MAXIMUM;
}

/**
 * #8187: resolve the effective min-rank override by replaying apply/revert events, latest wins. Gated on
 * the `.loopover-ams.yml` flag at EVERY read -- flipping `minRankAutotuneEnabled` off instantly restores
 * the shipped default with no cleanup, exactly like ORB's autotune vars. Bounds re-validate on every read,
 * so a hand-edited ledger row can never move the knob past safety. Null means "use the shipped default".
 */
export function readMinRankOverride(eventLedger: LedgerReader, options: { enabled: boolean }): number | null {
  if (!options.enabled) return null;
  let override: number | null = null;
  for (const record of readAll(eventLedger)) {
    if (record.type === MINER_AMS_MIN_RANK_REVERTED_EVENT) {
      override = null;
    } else if (record.type === MINER_AMS_MIN_RANK_APPLIED_EVENT) {
      const payload = record.payload as Record<string, unknown> | null | undefined;
      const value = payload && typeof payload === "object" ? payload.value : undefined;
      if (isValidMinRankOverride(value)) override = value;
    }
  }
  return override;
}

export type ApplyMinRankOverrideResult =
  | { applied: true; entry: LedgerEntry }
  | { applied: false; reason: "flag_off" | "not_approved" | "out_of_bounds" | "no_supporting_run" };

/**
 * #8187: the double-gated apply. Refuses unless the config flag is ON (gate one), the caller passed the
 * explicit per-apply approval (gate two), the value sits inside the hard bounds, AND a persisted run
 * inside the lookback actually cleared this exact candidate (evidence is not optional -- an operator
 * cannot approve a number no backtest earned). The evidence rides the apply event verbatim.
 */
export function applyMinRankOverride(
  value: number,
  options: { eventLedger: LedgerWriter & LedgerReader; enabled: boolean; approved: boolean; nowMs?: number },
): ApplyMinRankOverrideResult {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  if (!options.enabled) return { applied: false, reason: "flag_off" };
  if (!options.approved) return { applied: false, reason: "not_approved" };
  if (!isValidMinRankOverride(value)) return { applied: false, reason: "out_of_bounds" };
  const nowMs = options.nowMs ?? Date.now();
  const supporting = buildAmsBacktestProposals(readAmsThresholdBacktestRuns(eventLedger), nowMs).find(
    (proposal) => proposal.candidateThreshold === value,
  );
  if (!supporting) return { applied: false, reason: "no_supporting_run" };
  const entry = eventLedger.appendEvent({
    type: MINER_AMS_MIN_RANK_APPLIED_EVENT,
    payload: {
      ruleId: AMS_MIN_RANK_RULE_ID,
      value,
      shipped: AMS_MIN_RANK_SHIPPED,
      hardMaximum: AMS_MIN_RANK_HARD_MAXIMUM,
      evidence: supporting as unknown as Record<string, unknown>,
    },
  });
  return { applied: true, entry };
}

/** #8187's one-command revert: appends the reversion event (readMinRankOverride then resolves to shipped).
 *  Approval-gated like the apply -- reverting is also a knob movement, just a safe-ward one. */
export function revertMinRankOverride(options: {
  eventLedger: LedgerWriter;
  approved: boolean;
}): { reverted: boolean; reason?: "not_approved" } {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  if (!options.approved) return { reverted: false, reason: "not_approved" };
  eventLedger.appendEvent({
    type: MINER_AMS_MIN_RANK_REVERTED_EVENT,
    payload: { ruleId: AMS_MIN_RANK_RULE_ID, restoredValue: AMS_MIN_RANK_SHIPPED },
  });
  return { reverted: true };
}
