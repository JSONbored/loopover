// AMS eligibility-exclusion advisory backtest (#8545, epic #8107) — replays a candidate ContributionProfile
// against the miner's own captured eligibility-exclusion signal history (rule-fired + human-override events
// with bounded metadata from discover-cli's #8544 capture). Mirrors #8184's min-rank backtest shape: pure
// corpus assembly + engine replay math, zero live discovery behavior change.

import {
  AMS_MIN_RANK_HELD_OUT_FRACTION,
  AMS_MIN_RANK_MIN_HELD_OUT_CASES,
  AMS_MIN_RANK_MIN_VISIBLE_CASES,
  buildBacktestCorpus,
  compareBacktestScores,
  scoreBacktest,
  splitBacktestCorpus,
  type BacktestCase,
  type BacktestComparison,
  type HumanOverrideEvent,
  type RuleFiredEvent,
} from "@loopover/engine";
import { buildEligibilityExclusionMetadata } from "./discover-cli.js";
import type { ContributionProfile } from "./contribution-profile.js";
import { ELIGIBILITY_EXCLUSION_REASONS, filterCandidatesByProfiles } from "./contribution-profile-filter.js";
import { SIGNAL_HUMAN_OVERRIDE_EVENT, SIGNAL_RULE_FIRED_EVENT } from "./signal-tracking-store.js";

/** Synthetic rule id every eligibility replay case carries — namespaced away from the four live exclusion
 *  reason strings stored on the original fired events. */
export const AMS_ELIGIBILITY_RULE_ID = "ams_eligibility_exclusion";

/** Fixed-seed held-out split for eligibility replay — same fraction/floors as min-rank (#8184 reads them from
 *  ams-rank-corpus.ts; this module reuses those constants verbatim, per #8545). */
export const AMS_ELIGIBILITY_SPLIT_SEED = "ams-eligibility-exclusion-v1";

export const AMS_ELIGIBILITY_RULE_IDS = Object.freeze([
  ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
  ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
  ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
  ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE,
] as const);

type FilterCandidate = {
  repoFullName: string;
  owner?: string;
  labels?: string[];
  assignees?: string[];
};

type RuleFiredPayload = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

type HumanOverridePayload = {
  ruleId: string;
  targetKey: string;
  verdict: "reversed" | "confirmed";
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

function isEligibilityRuleId(ruleId: unknown): ruleId is (typeof AMS_ELIGIBILITY_RULE_IDS)[number] {
  return typeof ruleId === "string" && (AMS_ELIGIBILITY_RULE_IDS as readonly string[]).includes(ruleId);
}

function isRuleFiredPayload(payload: Record<string, unknown>, ruleId: string): payload is RuleFiredPayload {
  return (
    payload.ruleId === ruleId &&
    typeof payload.targetKey === "string" &&
    typeof payload.outcome === "string" &&
    typeof payload.occurredAt === "string"
  );
}

function isHumanOverridePayload(payload: Record<string, unknown>, ruleId: string): payload is HumanOverridePayload {
  return (
    payload.ruleId === ruleId &&
    typeof payload.targetKey === "string" &&
    (payload.verdict === "reversed" || payload.verdict === "confirmed") &&
    typeof payload.occurredAt === "string"
  );
}

function metadataCapturable(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const candidate: {
    owner?: string;
    labels?: string[];
    assignees?: string[];
  } = {};
  if (typeof metadata.owner === "string") candidate.owner = metadata.owner;
  if (Array.isArray(metadata.labels)) candidate.labels = metadata.labels as string[];
  if (Array.isArray(metadata.assignees)) candidate.assignees = metadata.assignees as string[];
  return buildEligibilityExclusionMetadata(candidate) !== undefined;
}

/** Reconstruct a {@link filterCandidatesByProfiles} candidate from a fired event's targetKey + metadata. */
export function reconstructEligibilityFilterCandidate(
  targetKey: string,
  metadata: Record<string, unknown>,
): FilterCandidate | null {
  const match = /^([^/]+\/[^/#]+)#issue-(\d+)$/.exec(targetKey);
  if (!match) return null;
  const candidate: FilterCandidate = { repoFullName: match[1]! };
  if (typeof metadata.owner === "string" && metadata.owner) candidate.owner = metadata.owner;
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (labels.length > 0) candidate.labels = labels;
  const assignees = Array.isArray(metadata.assignees)
    ? metadata.assignees.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (assignees.length > 0) candidate.assignees = assignees;
  return candidate;
}

/** Scan raw ledger rows for eligibility rule-fired + override events — same client-side filter discipline
 *  signal-tracking-store.ts uses, but across all four exclusion ruleIds at once. */
export function extractEligibilitySignalEvents(events: readonly unknown[]): {
  fired: RuleFiredEvent[];
  overrides: HumanOverrideEvent[];
  skippedNoContext: number;
} {
  const fired: RuleFiredEvent[] = [];
  const overrides: HumanOverrideEvent[] = [];
  let skippedNoContext = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const record = event as Record<string, unknown> | null | undefined;
    if (!record || typeof record !== "object") continue;
    const payload = record.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") continue;
    const ruleId = payload.ruleId;
    if (!isEligibilityRuleId(ruleId)) continue;
    if (record.type === SIGNAL_RULE_FIRED_EVENT) {
      if (!isRuleFiredPayload(payload, ruleId)) continue;
      if (!metadataCapturable(payload.metadata)) {
        skippedNoContext += 1;
        continue;
      }
      fired.push({
        ruleId,
        targetKey: payload.targetKey,
        outcome: payload.outcome,
        occurredAt: payload.occurredAt,
        metadata: payload.metadata!,
      });
    } else if (record.type === SIGNAL_HUMAN_OVERRIDE_EVENT && isHumanOverridePayload(payload, ruleId)) {
      overrides.push({
        ruleId,
        targetKey: payload.targetKey,
        verdict: payload.verdict,
        occurredAt: payload.occurredAt,
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
      });
    }
  }
  return { fired, overrides, skippedNoContext };
}

/** Repo full names referenced by capturable eligibility fired events — used to hydrate current profiles. */
export function repoFullNamesInEligibilityEvents(events: readonly unknown[]): Set<string> {
  const repos = new Set<string>();
  for (const event of extractEligibilitySignalEvents(events).fired) {
    const match = /^([^/]+\/[^/#]+)#issue-\d+$/.exec(event.targetKey);
    if (match) repos.add(match[1]!);
  }
  return repos;
}

/** Build a labeled replay corpus from eligibility signal history. Fired events without capturable metadata are
 *  counted in `skippedNoContext` and never guessed at. */
export function buildEligibilityExclusionCorpus(events: readonly unknown[]): {
  cases: BacktestCase[];
  skippedNoContext: number;
} {
  const { fired, overrides, skippedNoContext } = extractEligibilitySignalEvents(events);
  const cases: BacktestCase[] = [];
  for (const ruleId of AMS_ELIGIBILITY_RULE_IDS) {
    for (const backtestCase of buildBacktestCorpus(ruleId, fired, overrides)) {
      cases.push({ ...backtestCase, ruleId: AMS_ELIGIBILITY_RULE_ID });
    }
  }
  cases.sort((left, right) => {
    const key = left.targetKey.localeCompare(right.targetKey);
    return key !== 0 ? key : left.firedAt.localeCompare(right.firedAt);
  });
  return { cases, skippedNoContext };
}

/** Classifier factory: re-run {@link filterCandidatesByProfiles} under `profilesByRepo`. Excluding the
 *  reconstructed candidate classifies as the fired outcome (`confirmed`); keeping it classifies as not-fired
 *  (`reversed`). */
export function buildEligibilityProfileClassifier(
  profilesByRepo: Map<string, ContributionProfile>,
): (backtestCase: BacktestCase) => "reversed" | "confirmed" {
  return (backtestCase: BacktestCase) => {
    const metadata = backtestCase.metadata;
    if (!metadata) return "reversed";
    const candidate = reconstructEligibilityFilterCandidate(backtestCase.targetKey, metadata);
    if (!candidate) return "reversed";
    const { excluded } = filterCandidatesByProfiles([candidate], profilesByRepo);
    return excluded.length > 0 ? "confirmed" : "reversed";
  };
}

export type AmsEligibilityBacktestResult = {
  ruleId: string;
  skippedNoContext: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

function runEligibilitySlice(
  cases: readonly BacktestCase[],
  currentProfiles: Map<string, ContributionProfile>,
  candidateProfiles: Map<string, ContributionProfile>,
): BacktestComparison {
  const baseline = scoreBacktest(
    AMS_ELIGIBILITY_RULE_ID,
    cases,
    buildEligibilityProfileClassifier(currentProfiles),
  );
  const candidate = scoreBacktest(
    AMS_ELIGIBILITY_RULE_ID,
    cases,
    buildEligibilityProfileClassifier(candidateProfiles),
  );
  return compareBacktestScores(baseline, candidate);
}

/** Advisory replay of a candidate ContributionProfile against the eligibility-exclusion corpus — null when
 *  either split misses the shared min-rank sample floors (reused verbatim, per #8545). */
export function runAmsEligibilityBacktest(
  cases: readonly BacktestCase[],
  currentProfiles: Map<string, ContributionProfile>,
  candidateProfiles: Map<string, ContributionProfile>,
): Omit<AmsEligibilityBacktestResult, "skippedNoContext"> | null {
  const { visible, heldOut } = splitBacktestCorpus(
    cases,
    AMS_MIN_RANK_HELD_OUT_FRACTION,
    AMS_ELIGIBILITY_SPLIT_SEED,
  );
  if (visible.length < AMS_MIN_RANK_MIN_VISIBLE_CASES || heldOut.length < AMS_MIN_RANK_MIN_HELD_OUT_CASES) {
    return null;
  }
  return {
    ruleId: AMS_ELIGIBILITY_RULE_ID,
    visibleCases: visible.length,
    heldOutCases: heldOut.length,
    visible: runEligibilitySlice(visible, currentProfiles, candidateProfiles),
    heldOut: runEligibilitySlice(heldOut, currentProfiles, candidateProfiles),
  };
}

/** Convenience composition: ledger events -> labeled corpus -> advisory current-vs-candidate comparison. */
export function backtestEligibilityCandidate(
  events: readonly unknown[],
  currentProfiles: Map<string, ContributionProfile>,
  candidateProfiles: Map<string, ContributionProfile>,
): AmsEligibilityBacktestResult | null {
  const { cases, skippedNoContext } = buildEligibilityExclusionCorpus(events);
  const replay = runAmsEligibilityBacktest(cases, currentProfiles, candidateProfiles);
  if (!replay) return null;
  return { skippedNoContext, ...replay };
}
