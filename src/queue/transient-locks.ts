// Best-effort exclusive locking against the self-host transient cache (#4013 step 1 -- extracted from
// processors.ts, first step of the file's own module-split sequence). Two lock domains are built on the same
// generic primitive here: the per-PR actuation mutex (below) and the per-(repo, PR, head SHA, mode) AI-review
// lock, which stays in processors.ts (its own extraction is a later step in the split sequence) and imports
// claimTransientLock/releaseTransientLockIfOwner/TransientLockClaim back from this module.
//
// ONE shared per-PR actuation mutex (#2129/#2135) for every mutating PR pass: the sweep/webhook-driven
// maintenance plan-and-execute, the draft-dodge close, and the reopen-reclose. These are three INDEPENDENTLY
// triggered webhook/sweep paths for the SAME PR (e.g. a `reopened` event and a concurrent `check_suite
// completed` event, or a sweep tick racing either) that can be dequeued by separate workers at nearly the same
// time; each would read its own stale-but-still-"current" state, each would pass its own freshness checks, and
// each could independently fire a mutating call for the same PR. A single lock namespace is deliberate: separate
// per-path locks (the original design) do not exclude each other, so a maintenance pass and a draft-dodge close
// could still race — the whole point of this mutex is to make "does something else already own this PR" one
// question with one answer, not one question per code path (review round 4). This is a lightweight interim
// mutex (a full per-PR Durable Object / SubmissionLock is a separate, more-involved follow-up — see the TODO in
// env.d.ts) built on the SAME transient cache used for CI-completion coalescing in processors.ts, claimed
// ATOMICALLY (see claimTransientLock) so two racing deliveries can never both win the claim — a short TTL,
// best-effort release. A lock-contended caller fails OPEN (returns false / skips this pass) rather than
// blocking — the delivery holding the lock is evaluating the SAME PR, and the periodic sweep is the backstop
// if this specific trigger is dropped. A cache adapter with no claim() primitive gets NO exclusivity at all
// (every call proceeds) rather than a get-then-set pair that only *looks* atomic — see claimTransientLock's
// doc comment for why that fallback was removed.
//
// Per-holder ownership tokens + releaseIfValue (atomic compare-and-delete) close the race a shared constant
// lock value used to leave open: a holder that ran past the TTL can never have its stale `finally` release
// delete a later claimer's live lock (#2129/#2135) — release only succeeds when the caller's own token still
// matches what's stored.

import { randomUUID } from "node:crypto";
import { RetryableJobError } from "./retryable";

/** Result of a transient-lock claim attempt. `ownerToken` is the random value THIS call wrote when it actually
 *  acquired the lock, or null on every fail-open path (no cache, no atomic claim() primitive, a thrown claim(),
 *  or a lost race) — there is nothing for a null-token caller to release later. */
export type TransientLockClaim = {
  acquired: boolean;
  ownerToken: string | null;
};

/**
 * Best-effort exclusive claim against the self-host transient cache, shared by every per-PR/per-review advisory
 * lock below. Requires the store's native atomic claim() (Redis SET NX) to provide any real exclusivity — it is
 * the only way to close the race between two concurrent callers each observing an absent key. A plain
 * get-then-set pair CANNOT close that race in general, even with an extra write-then-verify re-read: caller A
 * can write its own token, read it straight back, and return true entirely BEFORE caller B's later write/read
 * also completes and also returns true — both callers "win" (#confirmed-bug). Rather than pretend to serialize
 * via a check that silently fails under exactly the concurrent load this lock exists to guard against, an
 * adapter without claim() gets NO exclusivity from this helper: every caller proceeds. This is honest about the
 * limitation rather than a false guarantee, and costs nothing in practice — self-host's Redis-backed cache (the
 * only cache adapter this codebase ships) always implements claim(), so this is a documented limitation for a
 * hypothetical future adapter, not a live gap. A missing cache or a thrown claim() also fails OPEN (returns
 * acquired: true) — every lock built on this helper is defense-in-depth, never the primary safety gate, and
 * must never itself block real work from running.
 *
 * The claimed value is a fresh random token per call, not a shared constant (#2129/#2135): release then
 * verifies this exact token still owns the key (see releaseTransientLockIfOwner) before deleting it, so a
 * holder that runs past its TTL can never have its stale `finally` release delete a DIFFERENT, live holder's
 * claim on the same key — the race this mutex exists to close in the first place.
 */
export async function claimTransientLock(
  env: Env,
  key: string,
  ttlSeconds: number,
): Promise<TransientLockClaim> {
  const cache = env.SELFHOST_TRANSIENT_CACHE;
  if (!cache?.claim) return { acquired: true, ownerToken: null }; // no atomic primitive — nothing to serialize against.
  // A claim()-only adapter without releaseIfValue would pin locks until TTL after normal work — reject that
  // shape at self-host boot (assertSelfhostTransientCacheOwnershipRelease). At runtime, fail open without
  // calling claim() so misconfigured test/custom adapters never acquire an unreleasable lock (#2129/#3153).
  if (!cache.releaseIfValue) return { acquired: true, ownerToken: null };
  const ownerToken = randomUUID();
  try {
    const acquired = await cache.claim(key, ownerToken, ttlSeconds);
    return { acquired, ownerToken: acquired ? ownerToken : null };
  } catch {
    return { acquired: true, ownerToken: null }; // fail open — see the doc comment above.
  }
}

/** Releases a transient lock ONLY when `ownerToken` still matches the stored value (atomic compare-and-delete),
 *  so a stale holder can never delete a different, live holder's claim on the same key. `ownerToken` is null
 *  on every fail-open claim path (nothing was actually claimed, so nothing to release). */
export async function releaseTransientLockIfOwner(env: Env, key: string, ownerToken: string | null): Promise<void> {
  if (!ownerToken) return;
  const cache = env.SELFHOST_TRANSIENT_CACHE;
  if (!cache?.releaseIfValue) return;
  try {
    await cache.releaseIfValue(key, ownerToken);
  } catch {
    // best-effort; the TTL is the backstop if release fails
  }
}

const PR_ACTUATION_LOCK_TTL_SECONDS = 600;
function prActuationLockKey(repoFullName: string, prNumber: number): string {
  return `pr-actuation-lock:${repoFullName.toLowerCase()}#${prNumber}`;
}
export async function claimPrActuationLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
): Promise<TransientLockClaim> {
  return claimTransientLock(
    env,
    prActuationLockKey(repoFullName, prNumber),
    PR_ACTUATION_LOCK_TTL_SECONDS,
  );
}
export async function releasePrActuationLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  ownerToken: string | null,
): Promise<void> {
  await releaseTransientLockIfOwner(env, prActuationLockKey(repoFullName, prNumber), ownerToken);
}

// A plain thrown Error still reaches the queue's retry path (this call site is deliberately uncaught, same as
// maybeRecloseDisallowedReopen's other error paths), but it only gets the queue's generic default backoff — far
// slower than the near-instant window a per-PR actuation lock is actually held for. Extending RetryableJobError
// gives lock contention its own fast, deterministic retry plus a distinct retryKind for observability, without
// changing the uncaught-and-propagate shape either call site already relies on (#2135/#2447).
export class PrActuationLockContendedError extends RetryableJobError {
  constructor(repoFullName: string, prNumber: number, policy: string) {
    super(`pr actuation lock contended for ${repoFullName}#${prNumber} during ${policy}`, {
      retryAfterMs: 5_000,
      retryKind: "pr_actuation_lock_contended",
    });
    this.name = "PrActuationLockContendedError";
  }
}
