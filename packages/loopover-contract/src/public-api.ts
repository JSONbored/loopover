/**
 * Public API response schemas shared by the Worker that serves them and the UI that renders them (#9282,
 * executed by #9521).
 *
 * The UI used to hand-author a TypeScript interface per response shape and keep it in sync by hand. It had
 * drifted: the UI's PublicStats was missing `fleetAccuracy.basis` and `rulePrecision.rules[].confirmed`
 * entirely, typed `decidedCount` as optional-but-not-nullable where the wire says nullable, typed
 * `accuracyTrend`'s counts as non-null where the wire says nullable, and marked `rulePrecision` optional
 * where the wire says required. Every one of those is a render-time surprise the compiler could not see.
 *
 * These are PLAIN zod objects, deliberately undecorated: src/openapi/schemas.ts applies `.openapi(...)` for
 * the OpenAPI document, which needs zod-to-openapi's extension and belongs on the Worker side. The UI takes
 * `z.infer` of the same objects, so a backend field change is a UI compile error with no generation step.
 */
import { z } from "zod";

/**
 * Measured per-rule precision over the trailing window (#8230): decided human verdicts per rule with
 * confirmed/decided precision, null below the public sample floor -- plus all three reversal-shape counts and
 * the latest backtest run's corpus checksum (the independently-verifiable freeze point).
 */
export const PublicRulePrecisionSchema = z.object({
  windowDays: z.number(),
  rules: z.array(z.object({ ruleId: z.string(), decided: z.number(), confirmed: z.number(), precision: z.number().nullable() })),
  reversals: z.object({ reopened: z.number(), reverted: z.number(), superseded: z.number() }),
  latestBacktestRun: z.object({ corpusChecksum: z.string(), at: z.string() }).nullable(),
});

export type PublicRulePrecision = z.infer<typeof PublicRulePrecisionSchema>;

export const PublicStatsSchema = z.object({
  generatedAt: z.string(),
  updatedAt: z.string(),
  totals: z.object({
    handled: z.number(),
    reviewed: z.number(),
    merged: z.number(),
    closed: z.number(),
    commented: z.number(),
    ignored: z.number(),
    manual: z.number(),
    error: z.number(),
    reversed: z.number(),
    filteredPct: z.number().nullable(),
    accuracyPct: z.number().nullable(),
    minutesSaved: z.number(),
  }),
  weekly: z.object({ reviewed: z.number(), merged: z.number() }),
  rulePrecision: PublicRulePrecisionSchema,
  byProject: z.array(
    z.object({
      project: z.string(),
      reviewed: z.number(),
      merged: z.number(),
      closed: z.number(),
      accuracyPct: z.number().nullable(),
    }),
  ),
  /** Live, fleet-wide reversal-grounded accuracy across REGISTERED self-hosted ORB instances -- unlike
   *  totals.accuracyPct (own-ledger, frozen as of the self-host cutover), this keeps growing with the fleet.
   *  accuracyPct is null until at least one registered instance clears the fleet's own minimum-volume bar. */
  fleetAccuracy: z.object({
    accuracyPct: z.number().nullable(),
    accuracyCiPct: z.object({ lo: z.number(), hi: z.number() }).nullable(),
    mergePrecisionPct: z.number().nullable(),
    mergePrecisionCiPct: z.object({ lo: z.number(), hi: z.number() }).nullable(),
    closePrecisionPct: z.number().nullable(),
    closePrecisionCiPct: z.object({ lo: z.number(), hi: z.number() }).nullable(),
    coveragePct: z.number().nullable(),
    // #9168: nullable because the pooled COUNT is withheld at 1 < instanceCount < FLEET_FRAMING_MIN_INSTANCES
    // — at exactly two instances it isolates the other participant's decision volume by subtraction, since
    // this deployment's own volume is already public. Rates stay published at every n.
    decidedCount: z.number().nullable(),
    guaranteed: z.object({
      close: z.object({ alpha: z.number(), lambda: z.number(), aiJudgedCoveragePct: z.number(), n: z.number(), backfilledPct: z.number().nullable() }).nullable(),
      merge: z.object({ alpha: z.number(), lambda: z.number(), aiJudgedCoveragePct: z.number(), n: z.number(), backfilledPct: z.number().nullable() }).nullable(),
    }),
    instanceCount: z.number(),
    // #9168: whether these figures are a fleet aggregate or one operator's self-report. Below
    // FLEET_FRAMING_MIN_INSTANCES a median is not robust to a single bad contributor and the anti-farming
    // detector cannot fire, so "fleet" would overclaim — the numbers are real either way, the label is what
    // stops a reader treating one party's self-report as corroboration of that party's own guarantee.
    basis: z.enum(["fleet", "single_instance_self_report"]),
    windowDays: z.number(),
    gamingFlagsCaught: z.number().nullable(),
  }),
  /** Trailing weekly history of totals.accuracyPct's SAME formula (#4447) -- null counts/accuracyPct on a week means
   *  too few decided (merged+closed) PRs to publish meaningful or non-identifying details. */
  accuracyTrend: z.array(
    z.object({
      weekStart: z.string(),
      merged: z.number().nullable(),
      closed: z.number().nullable(),
      reversed: z.number().nullable(),
      accuracyPct: z.number().nullable(),
    }),
  ),
  /** Trailing weekly FLEET accuracy (#9676). A SEPARATE series from `accuracyTrend`, never blended with it:
   *  that one is reversal-grounded over the own-ledger population (raw `owner/repo#number` keys), this one is
   *  `decisionAccuracy` over registered self-host instances' `orb_signals` (per-instance HMAC'd keys). The two
   *  populations cannot be joined, and #8820 established `decisionAccuracy` -- not `1 - reversalRate` -- as the
   *  fleet estimand, so this matches the headline it sits under rather than the table beside it. `verdicts`
   *  counts scored merge/close decisions only; holds and policy actions are excluded. Null on a week means too
   *  few scored verdicts to publish. */
  fleetAccuracyTrend: z.array(
    z.object({
      weekStart: z.string(),
      verdicts: z.number().nullable(),
      accuracyPct: z.number().nullable(),
    }),
  ),
  /** Trailing weekly "how often we avoid redoing AI work" trend (#4448) -- a competence signal, not a cost
   *  claim. Counts cache hits/misses across every instrumented AI-touching capability (grounding,
   *  review-memory, impact-map, repo-culture-profile, ai_review, ai_slop, linked_issue_satisfaction,
   *  miner_detection). null reuseRatePct on a week means too few total attempts to publish a meaningful
   *  percentage, not zero reuse. */
  reuseRateTrend: z.array(
    z.object({
      weekStart: z.string(),
      hits: z.number(),
      misses: z.number(),
      reuseRatePct: z.number().nullable(),
    }),
  ),
  /** Trailing weekly PR-review-volume/filtered-rate trend (#4445 follow-up) -- each week is the COHORT of PRs
   *  first published that week, `merged` reflects their CURRENT disposition (not necessarily merged the same
   *  week), and null filteredPct means too few reviewed PRs that week to publish a meaningful percentage. The
   *  most recent 1-2 weeks can read a lower filteredPct than they'll eventually settle at, since some of that
   *  cohort may still be in flight. */
  reviewVolumeTrend: z.array(
    z.object({
      weekStart: z.string(),
      reviewed: z.number(),
      merged: z.number(),
      filteredPct: z.number().nullable(),
    }),
  ),
});

export type PublicStats = z.infer<typeof PublicStatsSchema>;
