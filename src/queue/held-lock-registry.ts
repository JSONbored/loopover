/**
 * #8998 — release the transient locks THIS process currently holds the instant a shutdown signal arrives,
 * rather than only via graceful drain or TTL expiry.
 *
 * `queue.stop()` (#9007) already lets an in-flight job finish naturally before the process exits, and a job's
 * own `finally` block releases whatever lock it holds as part of that. That is the right behavior when the
 * orchestrator's SIGKILL grace period is long enough for the drain to complete. It is not always long enough:
 * an AI-review LLM call can legitimately run for tens of seconds to minutes, while a common container-platform
 * grace period is 10-30s. When the hard kill lands before the drain finishes, the lock this process claimed —
 * `ai-review-lock` most consequentially, at a 1800s TTL — outlives the process that claimed it by up to that
 * TTL, starving every subsequent pass (scheduled or an explicit maintainer re-run) with the "already in
 * progress" placeholder for real time nobody is actually reviewing anything.
 *
 * This is the proactive half: a tiny process-local registry of "locks I currently hold and how to release
 * them", so the shutdown handler can best-effort release every one of them immediately on SIGTERM/SIGINT —
 * before, and independent of, whether the graceful drain itself has time to finish. Complementary to, not a
 * replacement for, the boot-time orphaned-lock flush (#9021): that catches whatever this process didn't get a
 * chance to release (a truly hard `kill -9`, which delivers no signal at all); this catches everything else.
 */

type HeldLockRelease = () => Promise<void>;
type HeldLockEntry = { ownerToken: string; release: HeldLockRelease };

const heldLocks = new Map<string, HeldLockEntry>();

/** Record that this process now holds `key` under `ownerToken`, with `release` as how to give it up. Call the
 *  moment a claim actually succeeds with real ownership (a fail-open "acquired but nothing to release" claim
 *  has nothing worth registering — see the call site's own guard). */
export function registerHeldLock(key: string, ownerToken: string, release: HeldLockRelease): void {
  heldLocks.set(key, { ownerToken, release });
}

/**
 * Record that this process no longer holds `key` under `ownerToken` (its own release already ran).
 *
 * #9468: the unregister is CONDITIONAL on the token, mirroring the store-side compare-and-delete. Keyed by
 * lock key alone, a later holder's entry could be deleted by an earlier holder's cleanup: a maintainer's
 * forced re-run STEALS a live lock in the same process (#9008), overwriting the registry entry with the
 * stealer's release; when the original pass then finished, its `releaseTransientLockIfOwner` correctly no-oped
 * (wrong token) but its unregister still deleted the STEALER's entry. A SIGTERM during the stealer's
 * still-running review then skipped that key entirely, stranding it for the full 1800s TTL after a hard kill —
 * precisely the #8998 incident this registry exists to prevent. The same shape occurs when a fail-open claim
 * (null token from a Redis blip) later "releases".
 */
export function unregisterHeldLock(key: string, ownerToken: string): void {
  if (heldLocks.get(key)?.ownerToken === ownerToken) heldLocks.delete(key);
}

/** Best-effort release every lock currently on record, clearing the registry as it goes. Never throws: a
 *  release failure here just means that one lock rides out its own TTL, exactly the pre-#8998 behavior for
 *  every lock, rather than blocking the rest of shutdown. Returns the count attempted, for one shutdown log
 *  line — not the count that definitely succeeded, since a released key is removed from the registry either
 *  way and there is no further signal to distinguish the two once shutdown is already underway. */
export async function releaseAllHeldLocksAtShutdown(): Promise<number> {
  const entries = [...heldLocks.entries()];
  heldLocks.clear();
  let attempted = 0;
  for (const [, entry] of entries) {
    attempted += 1;
    await entry.release().catch(() => undefined);
  }
  return attempted;
}

/** Test-only introspection — never used by production code. */
export function heldLockCountForTest(): number {
  return heldLocks.size;
}
