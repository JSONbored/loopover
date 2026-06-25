// Gittensory Orb (#1255) — fleet calibration ANALYTICS. Reads the anonymized orb_signals collected from
// self-hosted instances and derives gate-accuracy metrics across the fleet. Aggregation is median/percentile
// (never mean) so a single instance contributing fabricated data cannot move the fleet numbers.

const MIN_DECIDED = 5; // an instance needs at least this many decided PRs to count toward the fleet median
const OUTLIER_BAND = 0.25; // |instance precision − fleet median| beyond this flags the instance

/** Per-instance confusion-matrix cell as stored. */
interface Cell {
  instance_id: string;
  verdict: string | null;
  outcome: string;
  reversal_flag: string;
  n: number;
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
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
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
  let cycle: number[] = [];
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
      .prepare(`SELECT time_to_close_ms AS ms FROM orb_signals WHERE received_at >= ? AND time_to_close_ms IS NOT NULL ORDER BY time_to_close_ms`)
      .bind(cutoff)
      .all<{ ms: number }>();
    cycle = (cy.results ?? []).map((r) => r.ms);
    // The fleet trust gate: only operator-registered instances count toward the median (open ingest stores
    // everyone's signals, but a stranger can't move calibration until a human opts them in — #1255).
    const reg = await env.DB.prepare(`SELECT instance_id FROM orb_instances WHERE registered = 1`).all<{ instance_id: string }>();
    registered = new Set((reg.results ?? []).map((r) => r.instance_id));
  } catch {
    return { windowDays, instanceCount: 0, fleet: { mergePrecision: null, closePrecision: null, fpRate: null, reversalRate: null, cycleP50Ms: null, cycleP95Ms: null }, instances: [], outliers: [] };
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
  };
}
