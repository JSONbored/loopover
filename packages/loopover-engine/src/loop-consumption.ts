// Per-loop compute consumption ledger entry (pure) — #4792, part of the Rent-a-Loop path #4778.
//
// Deterministic and side-effect-free: given ONE finished loop run's already-metered raw facts, it produces the
// consumption entry a rental ledger records for that run — the tenant it belongs to, the elapsed wall-clock it
// occupied, and the compute units it burned. It is the upstream counterpart to tenant-quota.ts's
// evaluateTenantQuota: summing these entries over a period yields exactly that function's TenantUsage
// (computeUnitsUsed / wallClockMsUsed), so allocation can be reconciled against real consumption.
//
// It computes an entry only: it does NOT write to a ledger, meter a running loop, or price anything. Persisting
// the entry is the separate, blocked-on-#4789/#4790 integration (and per #5669 must target whatever storage
// abstraction #4940/#5216 lands on, not raw SQLite a second time) — the decision core below has no storage
// opinion at all, so it stays correct whichever datastore that turns out to be.
//
// A KILLED run is a first-class case, not an error path: a loop stopped mid-run still consumed real compute and
// real wall-clock, so it MUST still bill accurately (#4792's second acceptance criterion). It produces the same
// shape as a completed run, flagged so a caller can tell a full run from a truncated one without inferring it.
// Every numeric input is normalized first, so clock skew, a non-finite reading, or an end-before-start timestamp
// can never make an entry negative, fractional, or NaN — a ledger that bills a tenant for -1 ms, or for NaN
// units, is worse than one that bills 0. Mirrors tenant-quota.ts's own normalization discipline.

/** How a loop run ended, for billing. Distinct from loop-escalation.ts's LoopRunOutcome, which describes a
 *  loop's health state (running/converged/abandoned/error); a consumption entry only exists for a run that has
 *  already stopped, and only cares whether it finished its work or was cut short. */
export type LoopConsumptionOutcome = "completed" | "killed";

/** One finished loop run's raw, already-metered facts — the input, never mutated. */
export type LoopRunFacts = {
  /** The tenant the run is billed to. */
  tenantId: string;
  /** The run's own identifier, carried through so an entry is traceable back to its loop. */
  loopId: string;
  /** Epoch-ms the loop started occupying compute. */
  startedAtMs: number;
  /** Epoch-ms it stopped — its own completion, or the moment it was killed. */
  endedAtMs: number;
  outcome: LoopConsumptionOutcome;
  /** Compute units the run actually burned, as metered by the caller. 0 when nothing metered it — never fabricated. */
  computeUnitsMetered: number;
};

/** One rental-ledger row: what a single loop run consumed, ready to sum into a period's TenantUsage. */
export type LoopConsumptionEntry = {
  tenantId: string;
  loopId: string;
  outcome: LoopConsumptionOutcome;
  /** Wall-clock ms the run occupied. Never negative, whatever the input timestamps say. */
  wallClockMs: number;
  /** Compute units consumed. Never negative/fractional/NaN. */
  computeUnits: number;
  /** False for a run killed mid-work — the entry is still accurate, just not a full run. */
  complete: boolean;
};

// Normalize any numeric input to a non-negative integer (a non-finite or negative value becomes 0), so no
// reading can make an entry NaN, fractional, or negative. Same rule as tenant-quota.ts's own inputs.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Build the rental-ledger consumption entry for one finished loop run. Pure: reads only the run it is handed
 * and returns an entry without mutating or storing anything.
 *
 * Elapsed wall-clock is `endedAtMs - startedAtMs`, floored at 0: a non-finite timestamp, or an end that
 * precedes its start (clock skew, or a kill recorded against a stale start), yields 0 rather than a negative
 * charge. Compute units are taken as metered and normalized the same way — never inferred from elapsed time,
 * because a loop that idled and one that saturated a core for the same duration did not consume the same
 * compute, and guessing would bill a tenant for work that never happened.
 *
 * A `killed` run yields the same shape as a `completed` one, with `complete: false`: it really did consume the
 * compute and time it occupied before being stopped, so it bills exactly like any other run (#4792) — the flag
 * only records that the work was truncated.
 */
export function buildLoopConsumptionEntry(facts: LoopRunFacts): LoopConsumptionEntry {
  const startedAtMs = finiteNonNegativeInt(facts.startedAtMs);
  const endedAtMs = finiteNonNegativeInt(facts.endedAtMs);

  return {
    tenantId: facts.tenantId,
    loopId: facts.loopId,
    outcome: facts.outcome,
    wallClockMs: Math.max(0, endedAtMs - startedAtMs),
    computeUnits: finiteNonNegativeInt(facts.computeUnitsMetered),
    complete: facts.outcome === "completed",
  };
}

/**
 * Sum a period's consumption entries into the shape tenant-quota.ts's evaluateTenantQuota reads, so an
 * allocation can be reconciled against what was really consumed (#4792's "queryable against allocation").
 * Pure. Entries for other tenants are ignored rather than silently mixed in: billing one tenant for another's
 * compute is the one mistake a rental ledger must never make, so the caller's filtering is not trusted here.
 * `activeLoops` is NOT derived — a finished run's entry says nothing about what is running right now, and
 * inventing a count would make evaluateTenantQuota's concurrency dimension decide on a fabricated number.
 */
export function totalConsumptionForTenant(
  entries: readonly LoopConsumptionEntry[],
  tenantId: string,
): { computeUnitsUsed: number; wallClockMsUsed: number } {
  let computeUnitsUsed = 0;
  let wallClockMsUsed = 0;
  for (const entry of entries) {
    if (entry.tenantId !== tenantId) continue;
    computeUnitsUsed += finiteNonNegativeInt(entry.computeUnits);
    wallClockMsUsed += finiteNonNegativeInt(entry.wallClockMs);
  }
  return { computeUnitsUsed, wallClockMsUsed };
}
