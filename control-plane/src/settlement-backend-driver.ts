// `SettlementBackendDriver` interface seam (#7572, implementing #6098's design spec). Mirrors the sibling
// `TenantProvisioningDriver` (control-plane/src/tenant-provisioning-driver.ts): a small, backend-agnostic
// contract plus a minimal in-memory fake, so #4792's rental-ledger work and #4791's settlement-scenario policy
// can build and test against a stable boundary regardless of which real backend — a future gittensor-owned
// settlement service, or a self-built one — eventually lands behind it.
//
// The interface names exactly the four hook points #6098 specifies for the "pool funded → work discovered →
// work delivered → payout owed" flow: fund a pool, query/decrement its balance, intake a payout-eligible event,
// and reverse a prior obligation (refund/dispute/partial-completion). Real backends MAY perform real money
// movement; this file defines only the contract and the fake — no real funds, credentials, or IO of any kind.
//
// GITTENSOR STRUCTURALLY IN THE PATH (#6098): every payout is keyed to a `gittensorContributor` — the
// gittensor-registered identity the emission is owed to — so a settlement can only ever be expressed as a
// gittensor-native payout. Even a self-built backend cannot decrement a pool for an unattributed recipient
// through this contract, making "gittensor is in the settlement path" structurally true rather than a policy
// promise. The actual refund/dispute POLICY stays #4791's job; this interface only names where it plugs in.

/** A funded reward pool's opaque id (matches #6098's `SettlementBackend.poolId` / the registry's `pool_id`). */
export type PoolId = string;

/**
 * A payout-eligible event (#6098): a merged PR against a subnet- or customer-funded repo, owing an emission to a
 * gittensor-registered contributor from a specific pool. Carries exactly what a backend needs to attribute and
 * settle the payout — not a ledger schema.
 */
export type PayoutEligibleEvent = {
  poolId: PoolId;
  /** The `owner/repo` whose merged PR triggered the payout. */
  repoFullName: string;
  /** The merged PR that delivered the work. */
  prNumber: number;
  /** The gittensor-registered contributor the emission is owed to. Keeping payouts keyed to a gittensor identity
   *  is what keeps gittensor structurally in the settlement path (#6098). */
  gittensorContributor: string;
  /** Amount owed, in the pool's own units. Precision/rounding policy is #4791's, not this interface's. */
  amount: number;
};

/** Why a prior payout obligation is being reversed (#6098's refund/dispute/partial-completion hook). The policy
 *  behind each is #4791's; the interface only enumerates where that policy plugs in. */
export type SettlementReversalReason = "refund" | "dispute" | "partial_completion";

export interface SettlementBackendDriver {
  /** "Pool funded" step: credit `amount` into a pool's allocation. Real backend → the funding source's transfer;
   *  the fake adds to an in-memory balance. */
  fundPool(poolId: PoolId, amount: number): Promise<void>;
  /** Read side of the balance contract: a pool's remaining allocation. A pool never funded reads as 0. */
  getPoolBalance(poolId: PoolId): Promise<number>;
  /** "Payout owed" intake: record a payout-eligible event and decrement its pool's balance by `event.amount`.
   *  MUST be idempotent per event (same repo+PR+pool+contributor) — re-recording a settled event is a no-op, so
   *  a redelivered webhook never double-pays. */
  recordPayoutEligibleEvent(event: PayoutEligibleEvent): Promise<void>;
  /** Refund/dispute/partial-completion hook: reverse a previously-recorded payout, crediting `event.amount` back
   *  to the pool. MUST be idempotent — reversing an unrecorded or already-reversed event is a no-op, never a
   *  throw. The reason is threaded through for #4791's policy/audit; this contract does not interpret it. */
  reversePayout(event: PayoutEligibleEvent, reason: SettlementReversalReason): Promise<void>;
}

/** The driver steps a fake records, for white-box assertions on call order and idempotency. */
export type FakeSettlementStep = "fundPool" | "recordPayoutEligibleEvent" | "reversePayout";

/** One recorded settlement call. */
export type FakeSettlementCall = {
  step: FakeSettlementStep;
  poolId: PoolId;
  amount: number;
};

/** A fake `SettlementBackendDriver` plus the recorded state a test inspects. */
export type FakeSettlementBackendDriver = SettlementBackendDriver & {
  /** Current remaining balance per pool (an in-memory stand-in for a real ledger). */
  readonly balances: ReadonlyMap<PoolId, number>;
  /** The keys of payout events currently recorded-and-not-reversed (`poolId|repo|pr|contributor`). */
  readonly settledEventKeys: ReadonlySet<string>;
  /** Every driver step this fake has run, in call order. */
  readonly calls: readonly FakeSettlementCall[];
};

/** Stable idempotency key for a payout event: the same delivered work never settles or reverses twice. */
function payoutEventKey(event: PayoutEligibleEvent): string {
  return `${event.poolId}|${event.repoFullName}|${event.prNumber}|${event.gittensorContributor}`;
}

/**
 * Minimal in-memory fake for contract/scenario tests — a balances map stands in for a real ledger, a set of
 * settled event keys enforces per-event idempotency, and an ordered call log records every step. NO real funds,
 * credentials, or IO. Mirrors `createFakeTenantProvisioningDriver`: implements the interface and exposes its
 * recorded state as extra introspection surface beyond the contract.
 */
export function createFakeSettlementBackendDriver(): FakeSettlementBackendDriver {
  const balances = new Map<PoolId, number>();
  const settledEventKeys = new Set<string>();
  const calls: FakeSettlementCall[] = [];

  return {
    get balances() {
      return balances;
    },
    get settledEventKeys() {
      return settledEventKeys;
    },
    get calls() {
      return calls;
    },
    async fundPool(poolId, amount) {
      calls.push({ step: "fundPool", poolId, amount });
      balances.set(poolId, (balances.get(poolId) ?? 0) + amount);
    },
    async getPoolBalance(poolId) {
      return balances.get(poolId) ?? 0;
    },
    async recordPayoutEligibleEvent(event) {
      calls.push({ step: "recordPayoutEligibleEvent", poolId: event.poolId, amount: event.amount });
      // Idempotent intake: a redelivered event (already settled) neither re-decrements the balance nor
      // double-records — the else-path is the "already settled" no-op.
      const key = payoutEventKey(event);
      if (!settledEventKeys.has(key)) {
        settledEventKeys.add(key);
        balances.set(event.poolId, (balances.get(event.poolId) ?? 0) - event.amount);
      }
    },
    async reversePayout(event, _reason) {
      calls.push({ step: "reversePayout", poolId: event.poolId, amount: event.amount });
      // Idempotent reversal: only a currently-settled event credits back; reversing an unrecorded or
      // already-reversed event is a no-op, never a throw.
      const key = payoutEventKey(event);
      if (settledEventKeys.has(key)) {
        settledEventKeys.delete(key);
        balances.set(event.poolId, (balances.get(event.poolId) ?? 0) + event.amount);
      }
    },
  };
}
