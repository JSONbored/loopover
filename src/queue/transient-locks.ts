// Best-effort exclusive locking (#4013 step 1 -- extracted from processors.ts). Two lock domains share the
// same generic primitive: the per-PR actuation mutex and the per-(repo, PR, head SHA, mode) AI-review lock
// (still wrapped in processors.ts / ai-review-orchestration.ts).
//
// ONE shared per-PR actuation mutex (#2129/#2135) for every mutating PR pass: maintenance plan-and-execute,
// draft-dodge close, and reopen-reclose. Independently triggered webhook/sweep paths for the SAME PR can be
// dequeued by separate workers at nearly the same time; a single lock namespace makes "does something else
// already own this PR" one question with one answer.
//
// Prefer the SubmissionLock Durable Object when `env.SUBMISSION_LOCK` is bound (#8896) — strongly consistent
// per-key serialization on hosted Workers. Self-host installs without Durable Objects keep the transient-cache
// mutex (Redis SET NX via claim()/releaseIfValue). A short TTL, best-effort release. Lock-contended callers
// fail closed at the call site (PrActuationLockContendedError); missing DO/cache or a thrown claim fails OPEN
// (returns acquired: true / skips exclusivity) so the lock stays defense-in-depth, never the primary safety
// gate. A cache adapter with no claim() primitive gets NO exclusivity (every call proceeds) — see
// claimTransientLock's doc comment.
//
// Per-holder ownership tokens + releaseIfValue (or DO compare-and-delete) close the race a shared constant
// lock value used to leave open: a holder that ran past the TTL can never have its stale `finally` release
// delete a later claimer's live lock (#2129/#2135).

import { randomUUID } from "node:crypto";
import { registerHeldLock, unregisterHeldLock } from "./held-lock-registry";
import { RetryableJobError } from "./retryable";

/** Result of a transient-lock claim attempt. `ownerToken` is the random value THIS call wrote when it actually
 *  acquired the lock, or null on every fail-open path (no cache, no atomic claim() primitive, a thrown claim(),
 *  or a lost race) — there is nothing for a null-token caller to release later. */
export type TransientLockClaim = {
  acquired: boolean;
  ownerToken: string | null;
};

/**
 * Exclusive claim preferring SubmissionLock when bound (#8896), else the self-host transient cache.
 * Requires the store's native atomic claim() (Redis SET NX) on the cache path to provide real exclusivity —
 * a plain get-then-set pair cannot close the race. An adapter without claim() gets NO exclusivity from this
 * helper: every caller proceeds. A missing cache/DO or a thrown claim() also fails OPEN (acquired: true) —
 * every lock built on this helper is defense-in-depth and must never itself block real work from running.
 *
 * The claimed value is a fresh random token per call (#2129/#2135): release verifies this exact token still
 * owns the key before deleting it.
 */
export async function claimTransientLock(
  env: Env,
  key: string,
  ttlSeconds: number,
  options?: { steal?: boolean },
): Promise<TransientLockClaim> {
  const viaDo = await claimSubmissionLockIfBound(env, key, ttlSeconds, options);
  if (viaDo !== null) return viaDo;

  const cache = env.SELFHOST_TRANSIENT_CACHE;
  if (!cache?.claim) return { acquired: true, ownerToken: null }; // no atomic primitive — nothing to serialize against.
  // A claim()-only adapter without releaseIfValue would pin locks until TTL after normal work — reject that
  // shape at self-host boot (assertSelfhostTransientCacheOwnershipRelease). At runtime, fail open without
  // calling claim() so misconfigured test/custom adapters never acquire an unreleasable lock (#2129/#3153).
  if (!cache.releaseIfValue) return { acquired: true, ownerToken: null };
  const ownerToken = randomUUID();
  // #9008: a `steal` caller (a maintainer's explicit forced re-run) intentionally takes ownership even from a
  // still-live holder — a duplicate LLM call is the accepted cost, and a self-host process that died mid-review
  // otherwise orphans this key for the FULL TTL with no recovery path (confirmed live: a lock outlived the
  // process that claimed it by 15+ minutes). `set` unconditionally overwrites (unlike `claim`'s SET-NX), so a
  // steal can never itself contend — that is the entire point.
  if (options?.steal) {
    try {
      await cache.set(key, ownerToken, ttlSeconds);
      return { acquired: true, ownerToken };
    } catch {
      return { acquired: true, ownerToken: null }; // fail open — same posture as every other claim failure
    }
  }
  try {
    const acquired = await cache.claim(key, ownerToken, ttlSeconds);
    return { acquired, ownerToken: acquired ? ownerToken : null };
  } catch {
    return { acquired: true, ownerToken: null }; // fail open — see the doc comment above.
  }
}

/** Releases a transient lock ONLY when `ownerToken` still matches the stored value (atomic compare-and-delete),
 *  so a stale holder can never delete a different, live holder's claim on the same key. `ownerToken` is null
 *  on every fail-open claim path (nothing was actually claimed, so nothing to release). Prefers SubmissionLock
 *  when bound (#8896); otherwise the cache path. */
export async function releaseTransientLockIfOwner(env: Env, key: string, ownerToken: string | null): Promise<void> {
  if (!ownerToken) return;
  if (await releaseSubmissionLockIfBound(env, key, ownerToken)) return;

  const cache = env.SELFHOST_TRANSIENT_CACHE;
  if (!cache?.releaseIfValue) return;
  try {
    await cache.releaseIfValue(key, ownerToken);
  } catch {
    // best-effort; the TTL is the backstop if release fails
  }
}

/** Returns a claim result when SUBMISSION_LOCK is bound; `null` means "use the cache fallback". */
async function claimSubmissionLockIfBound(
  env: Env,
  key: string,
  ttlSeconds: number,
  options?: { steal?: boolean },
): Promise<TransientLockClaim | null> {
  const ns = env.SUBMISSION_LOCK;
  if (!ns) return null;
  const ownerToken = randomUUID();
  try {
    const id = ns.idFromName(key);
    const response = await ns.get(id).fetch("https://submission-lock/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerToken, ttlSeconds, steal: options?.steal === true }),
    });
    const body = (await response.json().catch(() => null)) as { acquired?: unknown } | null;
    if (typeof body?.acquired !== "boolean") return { acquired: true, ownerToken: null }; // fail open
    return { acquired: body.acquired, ownerToken: body.acquired ? ownerToken : null };
  } catch {
    return { acquired: true, ownerToken: null }; // fail open — same posture as the cache path
  }
}

/** Returns true when the DO path handled the release (binding present); false means fall through to cache. */
async function releaseSubmissionLockIfBound(env: Env, key: string, ownerToken: string): Promise<boolean> {
  const ns = env.SUBMISSION_LOCK;
  if (!ns) return false;
  try {
    const id = ns.idFromName(key);
    await ns.get(id).fetch("https://submission-lock/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerToken }),
    });
  } catch {
    // best-effort; the TTL is the backstop if release fails
  }
  return true;
}

/**
 * #9467: keep a held lock alive for as long as its owner is actually working, instead of betting that the work
 * finishes inside a fixed TTL.
 *
 * The TTLs were sized when the actuation lock covered only a short plan-and-execute section. #9013 moved the
 * claim to BEFORE `maybePublishPrPublicSurface`, so the 600s actuation lock now wraps the entire publish -> AI
 * review -> maintain unit -- and the AI review alone can legitimately exceed it (3 attempts x up to 600s per
 * attempt, per model, with an operator override clamped at 1,800,000 ms per attempt). When the TTL lapsed
 * mid-work the holder was never told: a second worker claimed the same PR and both actuated it, producing a
 * duplicate close plus a duplicate explanation comment, or a losing pass's placeholder republished over a real
 * verdict -- the exact thrash #9013 existed to eliminate.
 *
 * The queue proved this shape for its own processing lease in #9023; this is the same idea for transient locks.
 * Renewal is compare-and-extend, so a holder that has ALREADY lost the key (TTL lapsed and someone re-claimed,
 * or a maintainer stole it via #9008) cannot extend the new owner's lock -- it learns it lost instead, via
 * `onLost`, and its caller aborts before mutating anything.
 *
 * Fails OPEN, exactly like every other operation in this module: an adapter without `renewIfValue`, or a
 * throwing renewal, simply leaves the lock on its original fixed TTL -- never worse than the pre-#9467
 * behavior, and never a reason to block real work.
 */
export type LockHeartbeat = { stop: () => void };

export function startLockHeartbeat(
  env: Env,
  key: string,
  ownerToken: string | null,
  ttlSeconds: number,
  options?: { onLost?: () => void; intervalMsOverride?: number },
): LockHeartbeat {
  const cache = env.SELFHOST_TRANSIENT_CACHE;
  // Nothing to renew: a fail-open claim owns no key, and an adapter without compare-and-extend cannot renew
  // safely (a blind re-set would extend whoever holds it now, which is the bug this exists to prevent).
  if (!ownerToken || !cache?.renewIfValue) return { stop: () => undefined };
  // A third of the TTL gives two chances to recover from a transient renewal failure before the lock lapses.
  const intervalMs = options?.intervalMsOverride ?? Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3));
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      // No pre-await `stopped` guard: stop() clears the interval, so a callback can never START after it.
      // The check that matters is the one AFTER the await below, where stop() CAN have landed mid-renewal.
      try {
        const stillOurs = await cache.renewIfValue!(key, ownerToken, ttlSeconds);
        if (!stillOurs && !stopped) {
          stopped = true;
          clearInterval(timer);
          options?.onLost?.();
        }
      } catch {
        // Fail open: a transient renewal error must not itself abort the work. The next tick retries, and if
        // renewals keep failing the lock simply lapses on its original TTL -- the pre-#9467 behavior.
      }
    })();
  }, intervalMs);
  // Never hold the process open for a heartbeat (Node only; the Workers runtime has no unref).
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export const PR_ACTUATION_LOCK_TTL_SECONDS = 600;
export function prActuationLockKeyForHeartbeat(repoFullName: string, prNumber: number): string {
  return prActuationLockKey(repoFullName, prNumber);
}
function prActuationLockKey(repoFullName: string, prNumber: number): string {
  return `pr-actuation-lock:${repoFullName.toLowerCase()}#${prNumber}`;
}
export async function claimPrActuationLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
): Promise<TransientLockClaim> {
  const key = prActuationLockKey(repoFullName, prNumber);
  const claim = await claimTransientLock(env, key, PR_ACTUATION_LOCK_TTL_SECONDS);
  if (claim.acquired && claim.ownerToken !== null) {
    registerHeldLock(key, claim.ownerToken, () => releaseTransientLockIfOwner(env, key, claim.ownerToken));
  }
  return claim;
}
export async function releasePrActuationLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  ownerToken: string | null,
): Promise<void> {
  const key = prActuationLockKey(repoFullName, prNumber);
  await releaseTransientLockIfOwner(env, key, ownerToken);
  if (ownerToken !== null) unregisterHeldLock(key, ownerToken);
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

// Per-(repo, author) contributor open-item-cap mutex (#7284-fix, TOCTOU race): every existing lock above
// scopes to ONE PR; the cap-membership decision is inherently about the AUTHOR's whole open-PR set on this
// repo, so a burst of sibling PRs from the same author needs ONE shared lock namespace keyed by author, not
// per-PR — two siblings' cap-checks (or a cap-check racing a merge) must never both proceed against a stale
// view of "how many of this author's PRs are currently open" at the same time. Same short-TTL, best-effort,
// per-holder-token shape as claimPrActuationLock above; see this module's own header comment for why a
// missing claim()/releaseIfValue() primitive fails OPEN rather than fake exclusivity.
// #9024: was 30s, sized only for the executor's brief contributorCapMergeRecheck() call. But
// maybeCloseForContributorCapOnOpen (processors.ts) holds this SAME lock across a much longer body -- a token
// mint, live GitHub calls, ensurePullRequestLabel, the nested pr-actuation-lock, and a full
// executeAgentMaintenanceActions pass (live-CI recheck + GitHub close) -- which can exceed 30s under GitHub
// rate-limit backoff. Once Redis expires the lock while that holder is still inside the executor, a
// concurrent sibling PR's cap check (or the executor's own pre-merge recheck) acquires it and evaluates the
// author's open-PR count before the in-flight close lands -- the exact TOCTOU #7284 this lock exists to close.
// Matches claimPrActuationLock's own 600s TTL, the other lock guarding a comparably long mutating body.
const CONTRIBUTOR_CAP_LOCK_TTL_SECONDS = 600;
function contributorCapLockKey(repoFullName: string, authorLogin: string): string {
  return `contributor-cap-lock:${repoFullName.toLowerCase()}:${authorLogin.toLowerCase()}`;
}
export async function claimContributorCapLock(
  env: Env,
  repoFullName: string,
  authorLogin: string,
): Promise<TransientLockClaim> {
  const key = contributorCapLockKey(repoFullName, authorLogin);
  const claim = await claimTransientLock(env, key, CONTRIBUTOR_CAP_LOCK_TTL_SECONDS);
  if (claim.acquired && claim.ownerToken !== null) {
    registerHeldLock(key, claim.ownerToken, () => releaseTransientLockIfOwner(env, key, claim.ownerToken));
  }
  return claim;
}
export async function releaseContributorCapLock(
  env: Env,
  repoFullName: string,
  authorLogin: string,
  ownerToken: string | null,
): Promise<void> {
  const key = contributorCapLockKey(repoFullName, authorLogin);
  await releaseTransientLockIfOwner(env, key, ownerToken);
  if (ownerToken !== null) unregisterHeldLock(key, ownerToken);
}
