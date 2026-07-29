// LoopOver Orb (#1255) — fleet calibration ANALYTICS. Reads the anonymized orb_signals collected from
// self-hosted instances and derives gate-accuracy metrics across the fleet. Aggregation is median/percentile
// (never mean) so a single instance contributing fabricated data cannot move the fleet numbers.
//
// ANTI-FARMING DETECTION (#2350): gamingPatternFlags below extends the existing outlier check with a more targeted,
// ONE-SIDED signal for the specific "gaming" pattern the issue describes -- an instance mass-submitting only
// trivially-safe PRs to inflate its own merge-precision. mergePrecision alone can't distinguish "gamed" from
// "genuinely excellent" (a careful team also has high precision); combining it with UNUSUALLY HIGH volume and
// UNUSUALLY LOW reversal-rate, all three simultaneously, is the actual farming signature: lots of easy merges,
// nothing risky enough to ever get reverted. Detection only — never an automatic action.
//
// SCOPE (explicit non-goals, read before extending): this flags a self-hosted INSTANCE, never an individual
// miner. The fleet pipeline (orb_signals, review_audit's export) carries NO per-actor identity by deliberate,
// repeatedly-stated design (review_audit has no login column; predicted_gate_calibration_ledger is explicitly
// documented as never-exported, citing THIS issue as the reason) -- a genuine per-miner detector would require
// adding a new anonymized per-actor signal to the export pipeline, which is a privacy-sensitive design
// decision deserving its own focused issue/PR, not a rushed addition here. This module never deanonymizes,
// never auto-bans, and never touches the live gate — instanceId here is the SAME opaque, HMAC-derived handle
// already used everywhere else in this pipeline (see selfhost/orb-collector.ts), nothing more identifying.
//
// OUT OF SCOPE: "duplicate-claim-election win-rate skew" (isDuplicateClusterWinnerByClaim,
// src/signals/duplicate-winner.ts) is NOT implemented here. Its outcome is never persisted anywhere in this
// pipeline — only the LOSING side of a duplicate cluster produces a finding (duplicate_pr_risk), bucketed as
// gate_reasoncode_bucket="duplicate_risk" on export with no cluster id and no actor linkage. There is no
// winner marker to measure a win-rate FROM, and a per-instance duplicate_risk rate would measure something
// different (how often THIS instance's own PRs lose a local collision) than "identities farming wins," so no
// proxy for it is implemented — a misleading proxy would be worse than none.

// Exported so the federated bundle export (#1970, src/orb/federated-bundle.ts) gates its own published
// precision on the SAME volume bar the fleet median uses — a bundle must not advertise a precision the fleet
// would refuse to count.
// #9783: the retention horizon is imported rather than restated, so the window this module trusts for cycle
// time cannot drift from the window the prune actually enforces. retention.ts imports only a JSON util, so
// this introduces no cycle.
import { retentionCutoffIsoForTable } from "../db/retention";

export const MIN_DECIDED = 5; // an instance needs at least this many decided PRs to count toward the fleet median
const OUTLIER_BAND = 0.25; // |instance precision − fleet median| beyond this flags the instance
const GAMING_VOLUME_MULTIPLIER = 2; // an instance's decided count more than this many times the fleet median
const GAMING_PRECISION_BAND = OUTLIER_BAND; // mergePrecision this far ABOVE the fleet median (one-sided)
const GAMING_REVERSAL_RATIO = 0.5; // reversalRate below this fraction of the fleet median
// #9068: below this many eligible instances, "an instance's volume/precision this far above the fleet
// median" is UNSATISFIABLE by construction (with 1 eligible instance it IS the median; with 2, either could
// be "above" the other trivially) — the detector cannot distinguish "gaming" from "the sole/only comparable
// data point" below this floor, so it does not run at all rather than publish a structurally-guaranteed zero
// as if it were a clean bill of health.
export const GAMING_MIN_ELIGIBLE = 3;
// #9168: the same floor, for the same reason, applied to the FRAMING rather than the detector. Below this
// many eligible instances a "fleet" aggregate is not one: at n=1 the pooled counts ARE the sole operator's
// own counts, and a median of one is that one value, so the robustness the median is chosen for does no work
// (at n=2 a median is just the mean of two). Publishing those numbers under fleet framing invites a reader to
// treat one party's self-report as independent corroboration of that same party's guarantee. The numbers stay
// published — they are real — but `basis` says which of the two they are.
export const FLEET_FRAMING_MIN_INSTANCES = GAMING_MIN_ELIGIBLE;
// #9068: an instance's reversalRate is a fraction of ALL its decided signals, so a genuinely well-run fleet
// commonly has a fleet-median reversalRate of exactly 0 — `reversalRate < 0 * GAMING_REVERSAL_RATIO` can never
// be true, so the "low reversal" conjunct (and therefore the whole flag) was structurally unfireable whenever
// the median was 0. This absolute floor gives "low reversal" a meaning even then: at/under 2% is suspiciously
// clean in absolute terms regardless of what the fleet median happens to be.
const GAMING_REVERSAL_ABSOLUTE_FLOOR = 0.02;

/** Per-instance confusion-matrix cell as stored. */
export interface Cell {
  instance_id: string;
  verdict: string | null;
  outcome: string;
  reversal_flag: string;
  /** #8825: `policy_action` marks a deliberate enforcement close (contributor cap, blacklist, copycat,
   *  review-nag, screenshot-table, linked-issue hard rule) rather than a claim about code quality. Null on
   *  rows exported before the bucket existed — treated as a normal quality verdict, matching prior behavior. */
  gate_reasoncode_bucket?: string | null;
  n: number;
}

interface CycleTime {
  instance_id: string;
  ms: number;
}

export interface InstanceMetrics {
  instanceId: string;
  decided: number;
  mergePrecision: number | null; // P(merged & not reverted | gate said merge)
  closePrecision: number | null; // P(closed & not reopened | gate said close)
  fpRate: number | null; // P(closed or reverted | gate said merge) — gate approved, it was wrong
  fnRate: number | null; // P(merged or reopened | gate said close) — gate blocked, it was wrong
  reversalRate: number; // share of ALL signals (incl. holds) carrying an explicit reversal marker
  /** Share of the gate's AUTONOMOUS decisions (merge/close verdicts) that the realized outcome confirmed —
   *  the number that actually answers "how often is the bot's decision right" (#8820).
   *
   *  NOT `1 − reversalRate`, which the public surface used to publish and which overstates accuracy two ways:
   *    1. its denominator counts `hold` verdicts, which are deferrals to a human, not decisions that can be
   *       right or wrong — on this fleet they were ~36% of all signals, diluting the rate toward zero; and
   *    2. its numerator counts only EXPLICIT reversal markers, so an outright misprediction (gate said
   *       merge, the PR ended up closed) never registered at all.
   *  Measured on the live fleet the two differ by ~6 points (93.6% vs 99.6%) — the gap is real errors, not
   *  rounding. null when the instance made no merge/close verdicts at all (holds only). */
  decisionAccuracy: number | null;
  /** #8825: enforcement closes excluded from the precision/accuracy scoring above (contributor cap, blacklist,
   *  copycat, review-nag, screenshot-table, linked-issue hard rule). Reported so the volume of policy actions
   *  stays visible instead of vanishing from every metric. */
  policyActions: number;
  /** #8829: the raw confusion counts behind the ratios above, so callers can POOL across instances and put a
   *  real interval on a published proportion. A ratio alone cannot be pooled (Simpson) or intervalled. */
  counts: { mergeVerdicts: number; mergeConfirmed: number; closeVerdicts: number; closeConfirmed: number; holds: number };
}

/** #2350: one self-hosted instance whose combined volume/precision/reversal-rate pattern looks like it is
 *  gaming the fleet-aggregate accuracy signal (see the module doc comment for the exact signature and its
 *  scope). Detection only — a human reads this, nothing here takes any action automatically. `instanceId` is
 *  the same opaque, HMAC-derived handle used throughout this pipeline; nothing more identifying is included. */
export interface GamingPatternFlag {
  instanceId: string;
  decided: number;
  mergePrecision: number;
  reversalRate: number;
  fleetMedianDecided: number;
  fleetMergePrecision: number;
  fleetReversalRate: number;
}

export interface FleetAnalytics {
  windowDays: number;
  instanceCount: number; // instances meeting MIN_DECIDED
  fleet: {
    mergePrecision: number | null;
    closePrecision: number | null;
    fpRate: number | null;
    reversalRate: number | null;
    /** Share of AUTONOMOUS decisions the realized outcome confirmed — the honest "decision accuracy"
     *  (#8820). See InstanceMetrics.decisionAccuracy for why this, not 1 − reversalRate, is the number to
     *  publish.
     *
     *  #9068: this is the POOLED proportion (mergeConfirmed+closeConfirmed)/(mergeVerdicts+closeVerdicts)
     *  over eligible instances, NOT the median of per-instance decisionAccuracy — a per-instance MEDIAN and a
     *  POOLED proportion are different estimands that only coincide by coincidence with equal per-instance
     *  volumes (true of today's single-instance fleet, not guaranteed once a second instance registers). This
     *  is also exactly what accuracyCiPct is a Wilson interval OVER downstream (public-stats.ts), so the two
     *  published figures are now guaranteed to describe the same population instead of merely usually
     *  agreeing. See decisionAccuracyMedian below for the per-instance-robust diagnostic this replaces as the
     *  published point estimate. */
    decisionAccuracy: number | null;
    /** #9068: the per-instance MEDIAN of decisionAccuracy — robust to a single instance's volume swamping the
     *  fleet figure, kept as a diagnostic now that `decisionAccuracy` above publishes the pooled proportion
     *  instead. Not itself published on the public surface; available to internal consumers that want the
     *  robust view. */
    decisionAccuracyMedian: number | null;
    cycleP50Ms: number | null;
    cycleP95Ms: number | null;
    /** #8829: confusion counts POOLED over eligible instances. Medians are robust to a bad contributor but
     *  cannot carry a sample size or an interval; the pooled counts can. With one registered instance (the
     *  fleet today) pooled and median views coincide. Coverage = verdicts / (verdicts + holds): the share of
     *  quality-scorable signals the gate actually decided — policy actions are enforcement, outside both. */
    pooled: { mergeVerdicts: number; mergeConfirmed: number; closeVerdicts: number; closeConfirmed: number; holds: number; policyActions: number; coverage: number | null };
  };
  instances: InstanceMetrics[];
  outliers: Array<{ instanceId: string; metric: string; value: number; fleetMedian: number }>;
  gamingPatternFlags: GamingPatternFlag[];
  /** #9068: whether the anti-farming detector ran at all (eligible.length >= GAMING_MIN_ELIGIBLE). An empty
   *  `gamingPatternFlags` is ambiguous between "the detector ran and found nothing" and "the detector cannot
   *  run yet" — this disambiguates, so a public surface can publish null ("not enough instances to compare")
   *  instead of a structurally-guaranteed zero presented as a positive safety signal. */
  gamingDetectionEligible: boolean;
  /** #9168: whether there are enough eligible instances for "fleet" to mean anything
   *  (eligible.length >= FLEET_FRAMING_MIN_INSTANCES). Separate from the numbers themselves, which stay
   *  published either way — this says whether they are a fleet aggregate or one operator's self-report, so a
   *  public surface can label them honestly instead of letting fleet framing imply corroboration that a
   *  single-instance sample cannot provide. */
  fleetFramingEligible: boolean;
  /** #9783: whether cycleP50Ms/cycleP95Ms cover the REQUESTED window. False when the window reaches past
   *  orb_signals' retention horizon: the folded rollups carry counts, not durations, so percentiles over the
   *  surviving rows would describe a shorter window than the caller asked for. The percentiles are null in
   *  that case rather than quietly narrowed -- this says which it is. */
  cycleTimeObservable: boolean;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank: the p-th percentile is the value at 1-based rank ceil(p/100 * N), i.e. index
  // ceil(p/100 * N) - 1. `Math.floor(p/100 * N)` overshot by one rank whenever p/100 * N was an
  // integer (e.g. P50 of an even-sized set returned the upper-half boundary — at the extreme, the
  // maximum). Clamp both ends so p=0 and p=100 stay in range.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** #8829: Wilson score interval for a binomial proportion — the interval every published accuracy/precision
 *  figure must carry. Wilson, never Wald: the Wald interval degenerates near p→0/1 (exactly where a gate
 *  metric lives — at 59/60 confirmed Wald claims impossible certainty, Wilson stays honest), and Wilson never
 *  leaves [0,1]. z defaults to 1.96 (95%). Returns null for zero trials — "no data" must render as no claim,
 *  never as a fabricated interval. PURE. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): { lo: number; hi: number } | null {
  if (trials <= 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Fold the confusion-matrix cells for one instance into accuracy metrics (reversals count as the gate
 *  being wrong: a reverted merge is a false positive; a reopened OR superseded close is a false negative —
 *  `superseded` (#8166) is the one-shot culture's dominant "bot was wrong" shape: the closed PR's work later
 *  merged via a successor PR, so the close is disconfirmed exactly like a literal reopen).
 *
 *  Exported for the federated bundle export (#1970, src/orb/federated-bundle.ts): a bundle publishes this
 *  instance's own precision for #6481 to compare against the peer median computed here, so both sides MUST use
 *  this one definition — reimplementing it there would silently make the comparison apples-to-oranges. Callers
 *  must pass a non-empty `cells` (reversalRate divides by the decided total). */
export function foldInstance(instanceId: string, cells: Cell[]): InstanceMetrics {
  let wouldMerge = 0, mergeConfirmed = 0, mergeFalse = 0;
  let wouldClose = 0, closeConfirmed = 0, closeFalse = 0;
  let reversals = 0, decided = 0, policyActions = 0;
  for (const c of cells) {
    decided += c.n;
    if (c.reversal_flag !== "none") reversals += c.n;
    // #8825: a deliberate enforcement close is not a quality prediction and can be neither confirmed nor
    // disconfirmed as one, so it is excluded from the precision/accuracy scoring entirely — counted on its own
    // (policyActions) rather than silently inflating either side. It still contributes to `decided` and
    // reversalRate, which measure activity and human overrides rather than gate correctness.
    if (c.gate_reasoncode_bucket === "policy_action") {
      policyActions += c.n;
      continue;
    }
    if (c.verdict === "merge") {
      wouldMerge += c.n;
      if (c.outcome === "merged" && c.reversal_flag !== "reverted") mergeConfirmed += c.n;
      else mergeFalse += c.n;
    } else if (c.verdict === "close") {
      wouldClose += c.n;
      if (c.outcome === "closed" && c.reversal_flag !== "reopened" && c.reversal_flag !== "superseded") closeConfirmed += c.n;
      else closeFalse += c.n;
    }
  }
  const verdicts = wouldMerge + wouldClose;
  return {
    instanceId,
    decided,
    mergePrecision: wouldMerge > 0 ? mergeConfirmed / wouldMerge : null,
    closePrecision: wouldClose > 0 ? closeConfirmed / wouldClose : null,
    fpRate: wouldMerge > 0 ? mergeFalse / wouldMerge : null,
    fnRate: wouldClose > 0 ? closeFalse / wouldClose : null,
    reversalRate: reversals / decided, // decided ≥ 1 (the instance has at least one cell)
    decisionAccuracy: verdicts > 0 ? (mergeConfirmed + closeConfirmed) / verdicts : null,
    policyActions,
    counts: { mergeVerdicts: wouldMerge, mergeConfirmed, closeVerdicts: wouldClose, closeConfirmed, holds: decided - verdicts - policyActions },
  };
}

/** Compute fleet calibration analytics over the collected orb_signals within the window. Fail-safe → empty. */
function emptyPooled(): FleetAnalytics["fleet"]["pooled"] {
  return { mergeVerdicts: 0, mergeConfirmed: 0, closeVerdicts: 0, closeConfirmed: 0, holds: 0, policyActions: 0, coverage: null };
}

export async function computeFleetAnalytics(env: Env, opts: { windowDays?: number } = {}): Promise<FleetAnalytics> {
  const windowDays = Number.isFinite(opts.windowDays) && (opts.windowDays as number) > 0 ? Math.min(opts.windowDays as number, 365) : 90;
  // Date-only cutoff (like computeGateEval) so it compares correctly whether received_at is ISO ('…T…Z')
  // or SQLite's CURRENT_TIMESTAMP space format ('YYYY-MM-DD HH:MM:SS').
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - windowDays * 86_400_000).toISOString().slice(0, 10);

  // #9783 follow-up: cycle time is the ONE metric the rollup cannot carry. The confusion matrix folds into
  // per-day cells and sums back exactly, but cycleP50Ms/cycleP95Ms are percentiles over individual
  // time_to_close_ms values -- percentiles are not summable, so no per-day count can reconstruct them, and
  // orb_signal_rollups deliberately stores counts rather than a sample of durations (an unbounded sample is
  // the growth problem retention exists to solve).
  //
  // So a window reaching past the retention horizon would compute percentiles over only the rows that
  // survived, and report them as if they described the whole window -- silently, exactly the failure this
  // change exists to prevent for the matrix. Instead the percentiles go null and this flag says why, the
  // same posture gamingDetectionEligible/fleetFramingEligible take: a public surface can label the gap
  // rather than be handed a number that quietly means something narrower than its window.
  //
  // Compared as instants, before the date-truncation above: at the default windowDays === the retention
  // window the two are equal and cycle time is fully observable. (The date-only cutoff then widens the query
  // by under a day at the oldest edge, where the prune may already have taken rows -- a sub-day sliver out
  // of ninety, which percentiles are robust to and which predates this change.)
  const retentionCutoffIso = retentionCutoffIsoForTable("orb_signals", nowMs);
  const cycleTimeObservable = retentionCutoffIso === null || nowMs - windowDays * 86_400_000 >= Date.parse(retentionCutoffIso);

  let cells: Cell[] = [];
  let cycleRows: CycleTime[] = [];
  let registered = new Set<string>();
  try {
    // #9783: UNION the live rows with the folded rollups. orb_signals is pruned at 90 days into
    // orb_signal_rollups (per instance, per day, whole confusion matrix), so reading only the raw table
    // would make every window that reaches past the prune silently under-count -- which is exactly the
    // failure mode that made adding retention here non-trivial in the first place. Both halves emit the same
    // Cell shape, and foldInstance sums cells, so duplicate (instance, verdict, outcome, ...) tuples across
    // the two sources add up correctly rather than needing a merge.
    //
    // Both halves take the same bound because `cutoff` above is already date-only, which is exactly what
    // `day` is -- so the boundary date is included on both sides. (The public weekly trend cannot do this:
    // it bounds on a full ISO instant, where a bare `day >= ?1` would drop the boundary day because a string
    // prefix sorts before the string it prefixes. See public-fleet-accuracy-trend.ts.)
    const matrix = await env.DB
      .prepare(
        `SELECT instance_id, gate_verdict AS verdict, outcome, reversal_flag, gate_reasoncode_bucket, COUNT(*) AS n
           FROM orb_signals WHERE received_at >= ?1
          GROUP BY instance_id, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket
         UNION ALL
         SELECT instance_id, gate_verdict AS verdict, outcome, reversal_flag, gate_reasoncode_bucket, n
           FROM orb_signal_rollups WHERE day >= ?1`,
      )
      .bind(cutoff)
      .all<Cell>();
    cells = matrix.results ?? [];
    const cy = await env.DB
      .prepare(
        `SELECT s.instance_id, s.time_to_close_ms AS ms
         FROM orb_signals s
         JOIN orb_instances i ON i.instance_id = s.instance_id AND i.registered = 1
         WHERE s.received_at >= ? AND s.time_to_close_ms IS NOT NULL
         ORDER BY s.time_to_close_ms`,
      )
      .bind(cutoff)
      .all<CycleTime>();
    cycleRows = cy.results ?? [];
    // The fleet trust gate: only operator-registered instances count toward the median (open ingest stores
    // everyone's signals, but a stranger can't move calibration until a human opts them in — #1255).
    const reg = await env.DB.prepare(`SELECT instance_id FROM orb_instances WHERE registered = 1`).all<{ instance_id: string }>();
    registered = new Set((reg.results ?? []).map((r) => r.instance_id));
  } catch {
    return {
      windowDays,
      instanceCount: 0,
      fleet: { mergePrecision: null, closePrecision: null, fpRate: null, reversalRate: null, decisionAccuracy: null, decisionAccuracyMedian: null, cycleP50Ms: null, cycleP95Ms: null, pooled: emptyPooled() },
      instances: [],
      outliers: [],
      gamingPatternFlags: [],
      gamingDetectionEligible: false,
      // Fails closed with the rest of this fallback: if the fleet tables cannot be read, we certainly cannot
      // claim a fleet aggregate. instanceCount is 0 here, so the public surface labels it a self-report and
      // publishes the nulls it already had.
      fleetFramingEligible: false,
      // The cycle percentiles here are null because there is no data at all, not because the window outran
      // retention -- so this reports the window's real observability rather than piling a second reason onto
      // the same nulls.
      cycleTimeObservable,
    };
  }

  // Group cells by instance, fold each.
  const byInstance = new Map<string, Cell[]>();
  for (const c of cells) {
    const list = byInstance.get(c.instance_id) ?? [];
    list.push(c);
    byInstance.set(c.instance_id, list);
  }
  const instances = [...byInstance.entries()].map(([id, cs]) => foldInstance(id, cs)).sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  // Fleet = median across REGISTERED instances with enough volume. Registration is the fleet's trust anchor
  // (open ingest stores everyone's signals; a stranger cannot move calibration until a human opts them in).
  //
  // #9168, on the OTHER property this median is often credited with: robustness to a single bad contributor
  // requires n >= 3, and this comment used to claim it unconditionally. At n=1 the median IS that instance's
  // value; at n=2 it is the mean of the two, which a single bad contributor moves by half its error. The
  // eligible count is therefore surfaced as `instanceCount` and gates both the gaming detector
  // (GAMING_MIN_ELIGIBLE) and the published framing (FLEET_FRAMING_MIN_INSTANCES) rather than being left for
  // a reader to infer.
  const eligible = instances.filter((i) => i.decided >= MIN_DECIDED && registered.has(i.instanceId));
  const eligibleIds = new Set(eligible.map((i) => i.instanceId));
  const cycle = cycleRows.filter((r) => eligibleIds.has(r.instance_id)).map((r) => r.ms);
  const nums = (sel: (i: InstanceMetrics) => number | null): number[] => eligible.map(sel).filter((v): v is number => v !== null);
  const fleetMergeP = median(nums((i) => i.mergePrecision));
  const fleetCloseP = median(nums((i) => i.closePrecision));

  const outliers: FleetAnalytics["outliers"] = [];
  if (fleetMergeP !== null) {
    for (const i of eligible) {
      if (i.mergePrecision !== null && Math.abs(i.mergePrecision - fleetMergeP) > OUTLIER_BAND) {
        outliers.push({ instanceId: i.instanceId, metric: "mergePrecision", value: i.mergePrecision, fleetMedian: fleetMergeP });
      }
    }
  }

  // #2350/#9068: gamingPatternFlags. Gated on fleetMergeP !== null (at least one eligible instance made a
  // comparable merge verdict) AND eligible.length >= GAMING_MIN_ELIGIBLE — below that floor, "this far above
  // the fleet median" is unsatisfiable by construction (an instance IS the median at n=1; either trivially
  // "wins" at n=2), so the detector must not run at all rather than publish a guaranteed zero as a clean bill
  // of health. decided/reversalRate are never null per-instance, so once `eligible` clears both gates, both
  // medians below are guaranteed non-null too.
  const gamingDetectionEligible = fleetMergeP !== null && eligible.length >= GAMING_MIN_ELIGIBLE;
  const gamingPatternFlags: FleetAnalytics["gamingPatternFlags"] = [];
  if (gamingDetectionEligible) {
    const fleetMedianDecided = median(eligible.map((i) => i.decided))!;
    const fleetReversalRate = median(eligible.map((i) => i.reversalRate))!;
    for (const i of eligible) {
      const highVolume = i.decided > fleetMedianDecided * GAMING_VOLUME_MULTIPLIER;
      const highPrecision = i.mergePrecision !== null && i.mergePrecision - fleetMergeP! > GAMING_PRECISION_BAND;
      // #9068: a fleet-median reversalRate of 0 is common (a healthy fleet), and a FRACTION of zero can never
      // be undercut — fall back to an absolute floor in that case so "low reversal" can still mean something.
      const lowReversal = fleetReversalRate > 0 ? i.reversalRate < fleetReversalRate * GAMING_REVERSAL_RATIO : i.reversalRate <= GAMING_REVERSAL_ABSOLUTE_FLOOR;
      if (highVolume && highPrecision && lowReversal) {
        gamingPatternFlags.push({
          instanceId: i.instanceId,
          decided: i.decided,
          mergePrecision: i.mergePrecision!,
          reversalRate: i.reversalRate,
          fleetMedianDecided,
          fleetMergePrecision: fleetMergeP!,
          fleetReversalRate,
        });
      }
    }
  }

  const pooled = emptyPooled();
  for (const i of eligible) {
    pooled.mergeVerdicts += i.counts.mergeVerdicts;
    pooled.mergeConfirmed += i.counts.mergeConfirmed;
    pooled.closeVerdicts += i.counts.closeVerdicts;
    pooled.closeConfirmed += i.counts.closeConfirmed;
    pooled.holds += i.counts.holds;
    pooled.policyActions += i.policyActions;
  }
  const pooledVerdicts = pooled.mergeVerdicts + pooled.closeVerdicts;
  pooled.coverage = pooledVerdicts + pooled.holds > 0 ? pooledVerdicts / (pooledVerdicts + pooled.holds) : null;
  // #9068: the published point estimate is the POOLED proportion (same population accuracyCiPct's Wilson
  // interval is computed over downstream in public-stats.ts), not the per-instance median — see the
  // decisionAccuracy field doc above for why the two are different estimands.
  const pooledDecisionAccuracy = pooledVerdicts > 0 ? (pooled.mergeConfirmed + pooled.closeConfirmed) / pooledVerdicts : null;

  return {
    windowDays,
    instanceCount: eligible.length,
    fleet: {
      mergePrecision: fleetMergeP,
      closePrecision: fleetCloseP,
      fpRate: median(nums((i) => i.fpRate)),
      reversalRate: median(nums((i) => i.reversalRate)),
      decisionAccuracy: pooledDecisionAccuracy,
      decisionAccuracyMedian: median(nums((i) => i.decisionAccuracy)),
      cycleP50Ms: cycleTimeObservable ? percentile(cycle, 50) : null,
      cycleP95Ms: cycleTimeObservable ? percentile(cycle, 95) : null,
      pooled,
    },
    instances,
    outliers,
    gamingPatternFlags,
    gamingDetectionEligible,
    fleetFramingEligible: eligible.length >= FLEET_FRAMING_MIN_INSTANCES,
    cycleTimeObservable,
  };
}

/** #4933: fleet-wide instance READINESS, not gate-calibration quality -- deliberately separate from (and
 *  named differently on the dashboard than) the "Fleet health" gate-precision card above, which this is
 *  often confused with despite measuring something unrelated. */
export interface FleetHealthSummary {
  healthyCount: number;
  unhealthyCount: number;
  // Never reported a health status, or its last report is older than HEALTH_STALE_HOURS -- an
  // unresponsive instance must read as "don't know," not silently keep counting as its last-known state.
  unknownCount: number;
  totalCount: number; // registered instances only, matching computeFleetAnalytics's own trust gate
}

// A bit over 2x the hourly export cron (server.ts's runOrbExport), so one missed tick doesn't immediately
// flip an instance to "unknown."
export const HEALTH_STALE_HOURS = 3;

export async function getFleetHealthSummary(env: Env, now: Date = new Date()): Promise<FleetHealthSummary> {
  const staleBefore = new Date(now.getTime() - HEALTH_STALE_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const row = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN healthy = 1 AND health_reported_at IS NOT NULL AND health_reported_at > ? THEN 1 ELSE 0 END) AS healthy_count,
         SUM(CASE WHEN healthy = 0 AND health_reported_at IS NOT NULL AND health_reported_at > ? THEN 1 ELSE 0 END) AS unhealthy_count,
         COUNT(*) AS total_count
       FROM orb_instances
       WHERE registered = 1`,
    )
      .bind(staleBefore, staleBefore)
      .first<{ healthy_count: number | null; unhealthy_count: number | null; total_count: number }>();
    const healthyCount = Number(row?.healthy_count ?? 0);
    const unhealthyCount = Number(row?.unhealthy_count ?? 0);
    /* v8 ignore next -- COUNT(*) always returns a non-null number for a matched row (unlike the SUM(CASE...)
     *  cells above, which legitimately return NULL over zero matching rows); the ?? 0 only guards `row` being
     *  absent entirely, which a scalar aggregate query never produces. */
    const totalCount = Number(row?.total_count ?? 0);
    return { healthyCount, unhealthyCount, unknownCount: totalCount - healthyCount - unhealthyCount, totalCount };
  } catch {
    return { healthyCount: 0, unhealthyCount: 0, unknownCount: 0, totalCount: 0 };
  }
}
