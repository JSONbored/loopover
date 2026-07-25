// Per-tenant resource quota evaluation (pure) — #4796, part of the Rent-a-Loop path #4778.
//
// Deterministic and side-effect-free: given ONE tenant's already-metered usage and their allocation (the
// paid/staked quota that #4792's rental ledger resolves), it decides whether the tenant is still within quota
// and, when not, which resource dimension was exhausted plus a clear, user-facing reason. It reads only the
// tenant it is handed, so evaluating one tenant can never observe or affect another's state — the isolation the
// multi-tenant quota model requires. It computes a decision only: it does NOT store usage, meter compute, or
// stop a loop; that enforcement wiring is a separate, maintainer-owned concern. Every numeric input is
// normalized first, so a non-finite, fractional, or negative usage/quota can never make a decision NaN,
// fractional, or negative. Mirrors the governor's pure rate-limit calculator (governor/rate-limit.ts).

/** A tenant's allocation — hard resource caps for the current billing period, from the rental ledger (#4792). */
export type TenantQuota = {
  /** Compute-unit ceiling for the period. */
  computeUnits: number;
  /** Wall-clock-millisecond ceiling for the period. */
  wallClockMs: number;
  /** Maximum loops the tenant may run at once. */
  maxConcurrentLoops: number;
};

/** A tenant's already-metered consumption this period — the input, never mutated. */
export type TenantUsage = {
  computeUnitsUsed: number;
  wallClockMsUsed: number;
  activeLoops: number;
};

/** The resource dimension a tenant exhausted, in the order they are checked. */
export type QuotaDimension = "compute" | "time" | "concurrency";

export type TenantQuotaDecision = {
  /** Whether the tenant is within quota and may consume more / start another loop. */
  allowed: boolean;
  /** The first exhausted dimension when blocked, else null. */
  exceeded: QuotaDimension | null;
  /** A clear, actionable, user-facing explanation when blocked, else null. */
  reason: string | null;
  /** Headroom left in each dimension (0 when exhausted), echoed for callers that render the decision. */
  remaining: { computeUnits: number; wallClockMs: number; concurrentLoops: number };
};

// Normalize any numeric input to a non-negative integer (a non-finite or negative value becomes 0), so usage
// and quota can never make a decision NaN, fractional, or negative.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function quotaReason(dimension: QuotaDimension, cap: number): string {
  switch (dimension) {
    case "compute":
      return `Quota exceeded: you have used all ${cap} compute units in your current allocation. Increase your allocation or wait for the next period before running more.`;
    case "time":
      return `Quota exceeded: you have used all ${cap} ms of wall-clock time in your current allocation. Increase your allocation or wait for the next period before running more.`;
    case "concurrency":
      return `Quota exceeded: you already have the maximum of ${cap} loops running. Wait for a running loop to finish before starting another.`;
  }
}

/**
 * Decide whether a tenant is within quota. Pure: reads only the given tenant's usage and quota and returns a
 * decision without mutating anything. Dimensions are checked in a fixed precedence — compute, then time, then
 * concurrency — and the FIRST exhausted one is reported so the tenant gets a single, clear, actionable message.
 * A dimension counts as exhausted when usage has reached (>=) its cap, so a tenant that has consumed its entire
 * allocation is stopped rather than allowed one more over the line. Because it never reads shared or other-tenant
 * state, one tenant hitting its quota has no effect on another tenant's decision.
 */
export function evaluateTenantQuota(usage: TenantUsage, quota: TenantQuota): TenantQuotaDecision {
  const computeUsed = finiteNonNegativeInt(usage.computeUnitsUsed);
  const timeUsed = finiteNonNegativeInt(usage.wallClockMsUsed);
  const loops = finiteNonNegativeInt(usage.activeLoops);
  const computeCap = finiteNonNegativeInt(quota.computeUnits);
  const timeCap = finiteNonNegativeInt(quota.wallClockMs);
  const loopCap = finiteNonNegativeInt(quota.maxConcurrentLoops);

  const remaining = {
    computeUnits: Math.max(0, computeCap - computeUsed),
    wallClockMs: Math.max(0, timeCap - timeUsed),
    concurrentLoops: Math.max(0, loopCap - loops),
  };

  let exceeded: QuotaDimension | null = null;
  let cap = 0;
  if (computeUsed >= computeCap) {
    exceeded = "compute";
    cap = computeCap;
  } else if (timeUsed >= timeCap) {
    exceeded = "time";
    cap = timeCap;
  } else if (loops >= loopCap) {
    exceeded = "concurrency";
    cap = loopCap;
  }

  return {
    allowed: exceeded === null,
    exceeded,
    reason: exceeded === null ? null : quotaReason(exceeded, cap),
    remaining,
  };
}

/**
 * #7662: the soft-warning counterpart to {@link evaluateTenantQuota}. Returns the FIRST dimension — same
 * compute→time→concurrency precedence as the hard check — whose remaining headroom has fallen to or below
 * `warnThreshold` of its cap (default 0.2 ⇒ ≤20% left / ≥80% consumed), the pre-exhaustion band a soft
 * "running low" notification fires in — or null when every bounded dimension still has comfortable headroom.
 * A dimension already exhausted (remaining 0) is owned by the hard check and is NOT warned on here; a
 * zero/undefined cap yields no meaningful fraction and is skipped. Pure: the caller decides whether/when to
 * actually fire a notification from the result (the delivery wiring rides #7647's admission-check point).
 */
export function evaluateTenantQuotaWarning(
  usage: TenantUsage,
  quota: TenantQuota,
  warnThreshold = 0.2,
): { warned: boolean; dimension: QuotaDimension | null; remaining: TenantQuotaDecision["remaining"] } {
  const { remaining } = evaluateTenantQuota(usage, quota);
  const byDimension: ReadonlyArray<[QuotaDimension, number, number]> = [
    ["compute", remaining.computeUnits, finiteNonNegativeInt(quota.computeUnits)],
    ["time", remaining.wallClockMs, finiteNonNegativeInt(quota.wallClockMs)],
    ["concurrency", remaining.concurrentLoops, finiteNonNegativeInt(quota.maxConcurrentLoops)],
  ];
  for (const [dimension, left, cap] of byDimension) {
    if (cap <= 0) continue;
    if (left > 0 && left / cap <= warnThreshold) {
      return { warned: true, dimension, remaining };
    }
  }
  return { warned: false, dimension: null, remaining };
}
