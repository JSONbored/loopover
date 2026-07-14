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

const MIN_DECIDED = 5; // an instance needs at least this many decided PRs to count toward the fleet median
const OUTLIER_BAND = 0.25; // |instance precision − fleet median| beyond this flags the instance
const GAMING_VOLUME_MULTIPLIER = 2; // an instance's decided count more than this many times the fleet median
const GAMING_PRECISION_BAND = OUTLIER_BAND; // mergePrecision this far ABOVE the fleet median (one-sided)
const GAMING_REVERSAL_RATIO = 0.5; // reversalRate below this fraction of the fleet median

/** Per-instance confusion-matrix cell as stored. */
interface Cell {
  instance_id: string;
  verdict: string | null;
  outcome: string;
  reversal_flag: string;
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
  reversalRate: number; // share of decided PRs a human reversed
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
    cycleP50Ms: number | null;
    cycleP95Ms: number | null;
  };
  instances: InstanceMetrics[];
  outliers: Array<{ instanceId: string; metric: string; value: number; fleetMedian: number }>;
  gamingPatternFlags: GamingPatternFlag[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank: the p-th percentile is the value at 1-based rank ceil(p/100 * N), i.e. index
  // ceil(p/100 * N) - 1. `Math.floor(p/100 * N)` overshot by one rank whenever p/100 * N was an
  // integer (e.g. P50 of an even-sized set returned the upper-half boundary — at the extreme, the
  // maximum). Clamp both ends so p=0 and p=100 stay in range.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Fold the confusion-matrix cells for one instance into accuracy metrics (reversals count as the gate
 *  being wrong: a reverted merge is a false positive; a reopened close is a false negative). */
function foldInstance(instanceId: string, cells: Cell[]): InstanceMetrics {
  let wouldMerge = 0, mergeConfirmed = 0, mergeFalse = 0;
  let wouldClose = 0, closeConfirmed = 0, closeFalse = 0;
  let reversals = 0, decided = 0;
  for (const c of cells) {
    decided += c.n;
    if (c.reversal_flag !== "none") reversals += c.n;
    if (c.verdict === "merge") {
      wouldMerge += c.n;
      if (c.outcome === "merged" && c.reversal_flag !== "reverted") mergeConfirmed += c.n;
      else mergeFalse += c.n;
    } else if (c.verdict === "close") {
      wouldClose += c.n;
      if (c.outcome === "closed" && c.reversal_flag !== "reopened") closeConfirmed += c.n;
      else closeFalse += c.n;
    }
  }
  return {
    instanceId,
    decided,
    mergePrecision: wouldMerge > 0 ? mergeConfirmed / wouldMerge : null,
    closePrecision: wouldClose > 0 ? closeConfirmed / wouldClose : null,
    fpRate: wouldMerge > 0 ? mergeFalse / wouldMerge : null,
    fnRate: wouldClose > 0 ? closeFalse / wouldClose : null,
    reversalRate: reversals / decided, // decided ≥ 1 (the instance has at least one cell)
  };
}

/** Compute fleet calibration analytics over the collected orb_signals within the window. Fail-safe → empty. */
export async function computeFleetAnalytics(env: Env, opts: { windowDays?: number } = {}): Promise<FleetAnalytics> {
  const windowDays = Number.isFinite(opts.windowDays) && (opts.windowDays as number) > 0 ? Math.min(opts.windowDays as number, 365) : 90;
  // Date-only cutoff (like computeGateEval) so it compares correctly whether received_at is ISO ('…T…Z')
  // or SQLite's CURRENT_TIMESTAMP space format ('YYYY-MM-DD HH:MM:SS').
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  let cells: Cell[] = [];
  let cycleRows: CycleTime[] = [];
  let registered = new Set<string>();
  try {
    const matrix = await env.DB
      .prepare(
        `SELECT instance_id, gate_verdict AS verdict, outcome, reversal_flag, COUNT(*) AS n
         FROM orb_signals WHERE received_at >= ?
         GROUP BY instance_id, gate_verdict, outcome, reversal_flag`,
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
    return { windowDays, instanceCount: 0, fleet: { mergePrecision: null, closePrecision: null, fpRate: null, reversalRate: null, cycleP50Ms: null, cycleP95Ms: null }, instances: [], outliers: [], gamingPatternFlags: [] };
  }

  // Group cells by instance, fold each.
  const byInstance = new Map<string, Cell[]>();
  for (const c of cells) {
    const list = byInstance.get(c.instance_id) ?? [];
    list.push(c);
    byInstance.set(c.instance_id, list);
  }
  const instances = [...byInstance.entries()].map(([id, cs]) => foldInstance(id, cs)).sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  // Fleet = median across REGISTERED instances with enough volume (robust to a single bad contributor and
  // to unregistered/untrusted senders — registration is the fleet's trust anchor).
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

  // #2350: gamingPatternFlags. Gated on fleetMergeP !== null (at least one eligible instance made a comparable
  // merge verdict) — decided/reversalRate are never null per-instance, so once `eligible` is known non-empty
  // (implied by fleetMergeP being resolvable), both medians below are guaranteed non-null too.
  const gamingPatternFlags: FleetAnalytics["gamingPatternFlags"] = [];
  if (fleetMergeP !== null) {
    const fleetMedianDecided = median(eligible.map((i) => i.decided))!;
    const fleetReversalRate = median(eligible.map((i) => i.reversalRate))!;
    for (const i of eligible) {
      const highVolume = i.decided > fleetMedianDecided * GAMING_VOLUME_MULTIPLIER;
      const highPrecision = i.mergePrecision !== null && i.mergePrecision - fleetMergeP > GAMING_PRECISION_BAND;
      const lowReversal = i.reversalRate < fleetReversalRate * GAMING_REVERSAL_RATIO;
      if (highVolume && highPrecision && lowReversal) {
        gamingPatternFlags.push({
          instanceId: i.instanceId,
          decided: i.decided,
          mergePrecision: i.mergePrecision!,
          reversalRate: i.reversalRate,
          fleetMedianDecided,
          fleetMergePrecision: fleetMergeP,
          fleetReversalRate,
        });
      }
    }
  }

  return {
    windowDays,
    instanceCount: eligible.length,
    fleet: {
      mergePrecision: fleetMergeP,
      closePrecision: fleetCloseP,
      fpRate: median(nums((i) => i.fpRate)),
      reversalRate: median(nums((i) => i.reversalRate)),
      cycleP50Ms: percentile(cycle, 50),
      cycleP95Ms: percentile(cycle, 95),
    },
    instances,
    outliers,
    gamingPatternFlags,
  };
}
