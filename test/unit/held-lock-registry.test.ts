import { describe, expect, it, vi } from "vitest";
import { heldLockCountForTest, registerHeldLock, releaseAllHeldLocksAtShutdown, unregisterHeldLock } from "../../src/queue/held-lock-registry";
import { claimAiReviewLock, releaseAiReviewLock } from "../../src/queue/ai-review-orchestration";
import { createTestEnv } from "../helpers/d1";

// #8998: queue.stop() (#9007) already lets an in-flight job finish naturally, releasing its own lock via its
// own finally block — but only if the orchestrator's SIGKILL grace period is long enough for that drain to
// finish, and an AI-review LLM call can legitimately outrun a common 10-30s grace period. This registry is the
// proactive half: release every lock this process holds THE INSTANT a shutdown signal arrives, rather than
// only via graceful drain or the lock's own (up to 1800s) TTL.
describe("held-lock-registry (#8998)", () => {
  it("releases every registered lock and reports how many it attempted", async () => {
    const released: string[] = [];
    registerHeldLock("lock:a", async () => void released.push("a"));
    registerHeldLock("lock:b", async () => void released.push("b"));

    expect(await releaseAllHeldLocksAtShutdown()).toBe(2);
    expect(released.sort()).toEqual(["a", "b"]);
  });

  it("clears the registry as it goes, so a second shutdown call has nothing left to release", async () => {
    registerHeldLock("lock:c", async () => undefined);
    await releaseAllHeldLocksAtShutdown();

    expect(await releaseAllHeldLocksAtShutdown()).toBe(0);
  });

  it("unregistering removes a lock before shutdown ever needs to touch it — the normal, non-crash path", async () => {
    const release = vi.fn(async () => undefined);
    registerHeldLock("lock:d", release);
    unregisterHeldLock("lock:d");

    expect(await releaseAllHeldLocksAtShutdown()).toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it("keeps releasing the rest when one release throws — one bad lock must not strand the others", async () => {
    const released: string[] = [];
    registerHeldLock("lock:e", async () => {
      throw new Error("cache unreachable");
    });
    registerHeldLock("lock:f", async () => void released.push("f"));

    expect(await releaseAllHeldLocksAtShutdown()).toBe(2);
    expect(released).toEqual(["f"]);
  });

  it("re-registering the same key replaces the prior release rather than accumulating both", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerHeldLock("lock:g", first);
    registerHeldLock("lock:g", second);

    expect(heldLockCountForTest()).toBe(1);
    await releaseAllHeldLocksAtShutdown();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does nothing and reports zero when the registry is empty", async () => {
    expect(await releaseAllHeldLocksAtShutdown()).toBe(0);
  });
});

// The actual integration this registry exists for: claimAiReviewLock/releaseAiReviewLock are the canonical
// claim/release points for the SPECIFIC lock class #8998 is about (a 1800s TTL is the whole reason a proactive
// release matters far more here than for a short-TTL lock).
describe("claimAiReviewLock / releaseAiReviewLock register with the held-lock registry (#8998)", () => {
  it("registers a real claim, and the shutdown release actually frees the underlying lock", async () => {
    const env = createTestEnv();
    const before = heldLockCountForTest();
    const claim = await claimAiReviewLock(env, "acme/widgets", 3, "sha3", "block");
    expect(claim.acquired).toBe(true);
    expect(heldLockCountForTest()).toBe(before + 1);

    // A second claim on the SAME key must be denied while this process holds it...
    expect((await claimAiReviewLock(env, "acme/widgets", 3, "sha3", "block")).acquired).toBe(false);

    // ...until the shutdown-time release runs, which is the entire point: it frees the lock even though
    // nothing ever explicitly called releaseAiReviewLock itself (standing in for "the process died").
    expect(await releaseAllHeldLocksAtShutdown()).toBe(before + 1);
    expect((await claimAiReviewLock(env, "acme/widgets", 3, "sha3", "block")).acquired).toBe(true);
  });

  it("unregisters on the normal release path, so shutdown finds nothing left for an already-completed pass", async () => {
    const env = createTestEnv();
    const before = heldLockCountForTest();
    const claim = await claimAiReviewLock(env, "acme/widgets", 4, "sha4", "block");
    await releaseAiReviewLock(env, "acme/widgets", 4, "sha4", "block", claim.ownerToken);

    expect(heldLockCountForTest()).toBe(before);
  });

  it("does not register a fail-open claim — there is nothing real to release", async () => {
    // #5027: createTestEnv() always carries a working SELFHOST_TRANSIENT_CACHE, so it has to be stripped
    // explicitly here to reach claimTransientLock's own fail-open path (no atomic primitive bound at all),
    // which returns ownerToken: null (transient-locks.ts) — that must not be registered as a held lock.
    const env = createTestEnv();
    delete (env as { SELFHOST_TRANSIENT_CACHE?: unknown }).SELFHOST_TRANSIENT_CACHE;
    const before = heldLockCountForTest();
    const claim = await claimAiReviewLock(env, "acme/widgets", 5, "sha5", "block");

    expect(claim.ownerToken).toBeNull();
    expect(heldLockCountForTest()).toBe(before);
  });
});
