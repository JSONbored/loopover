import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRepoCloneLock, DEFAULT_LOCK_INCOMPLETE_GRACE_MS, ensureRepoCloned, isRepoCloneLockStale } from "../../packages/loopover-miner/lib/repo-clone";
import {
  cleanupResourceCount,
  closeAllCleanupResources,
  resetProcessLifecycleForTesting,
} from "../../packages/loopover-miner/lib/process-lifecycle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetProcessLifecycleForTesting();
});

function tempRepoPath() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-repo-clone-lock-"));
  roots.push(root);
  const repoPath = join(root, "acme", "widgets");
  return { root, repoPath, lockPath: `${repoPath}.clone.lock` };
}

function writeLockFile(lockPath: string, meta: unknown) {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, typeof meta === "string" ? meta : JSON.stringify(meta));
}

const at1000 = new Date(1000).toISOString();

describe("isRepoCloneLockStale (#7084)", () => {
  // A statLock stub that reports a fixed mtime, so incomplete-lock staleness is driven purely by nowMs vs mtime.
  const statAt = (mtimeMs: number) => () => ({ mtimeMs });

  it("treats a missing lockfile as stale (nothing to hold)", () => {
    const { lockPath } = tempRepoPath();
    // Never created: readFileSync throws, then the default statSync also throws -> reclaimable.
    expect(isRepoCloneLockStale(lockPath, 1000, 5000)).toBe(true);
  });

  it("REGRESSION (#9681): an unparseable/partial lockfile is NOT stale within the incomplete-grace window, but IS past it", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, "{ not valid json"); // the 0-byte / mid-write state open('wx') leaves before writeLock
    const now = 10_000;
    // mtime == now: a concurrent holder is probably still mid-acquire -> must NOT be reclaimed (was: always stale).
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(now))).toBe(false);
    // At the grace bound exactly (5s old) -> still held; just past it (6s old) -> genuinely abandoned -> reclaim.
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(now - DEFAULT_LOCK_INCOMPLETE_GRACE_MS))).toBe(false);
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(now - 6_000))).toBe(true);
  });

  it("REGRESSION (#9681): a non-object payload is grace-windowed the same way, and a stat that throws is stale", () => {
    const { lockPath } = tempRepoPath();
    const now = 10_000;
    writeLockFile(lockPath, "null");
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(now))).toBe(false); // within grace
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(1_000))).toBe(true); // 9s old > 5s grace
    writeLockFile(lockPath, "123");
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statAt(now))).toBe(false);
    // The file vanished between the failed read and the stat -> nothing to hold -> reclaimable.
    const statThrows = () => {
      throw new Error("ENOENT");
    };
    expect(isRepoCloneLockStale(lockPath, now, 5000, () => true, statThrows)).toBe(true);
  });

  it("reclaims a same-host lock whose owner PID is dead", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: 4242, at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => false)).toBe(true);
  });

  it("does not consult the PID probe when the owner PID isn't a usable integer", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: "x", at: at1000 });
    // Non-integer pid -> skip liveness, fall through to the age check (fresh -> not stale).
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => false)).toBe(false);
  });

  it("NEVER age-reclaims a live same-host owner, no matter how long its clone runs", () => {
    // The #7161 close's key blocker: a legitimately-slow local clone must not have its lock stolen by a waiter.
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: 4242, at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1000 + 5000, 5000, () => true)).toBe(false); // at the age bound
    expect(isRepoCloneLockStale(lockPath, 1000 + 500_000, 5000, () => true)).toBe(false); // far past it — still held
    // A dead same-host owner is still reclaimed immediately, regardless of age.
    expect(isRepoCloneLockStale(lockPath, 1000 + 500_000, 5000, () => false)).toBe(true);
  });

  it("applies the age backstop only to an un-probeable owner (non-integer pid), fresh vs over-age", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: "x", at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => false)).toBe(false); // fresh -> held
    expect(isRepoCloneLockStale(lockPath, 1000 + 5001, 5000, () => false)).toBe(true); // over-age -> reclaim
    // An un-probeable owner with an unparseable timestamp is stale (can't establish liveness or age).
    writeLockFile(lockPath, { host: hostname(), pid: "x", at: "not-a-time" });
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => false)).toBe(true);
  });

  it("judges a cross-host lock by age alone, never by this host's PID namespace", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: "some-other-container", pid: 4242, at: at1000 });
    // Even with a 'dead' probe, a different host's pid is irrelevant — fresh age keeps it held.
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => false)).toBe(false);
    expect(isRepoCloneLockStale(lockPath, 1000 + 6000, 5000, () => false)).toBe(true);
  });

  it("uses the real same-namespace liveness probe when no isAlive is injected", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: process.pid, at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1000, 5_000_000)).toBe(false); // this process is alive + fresh
    writeLockFile(lockPath, { host: hostname(), pid: 9_999_999, at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1000, 5_000_000)).toBe(true); // dead pid
  });
});

describe("acquireRepoCloneLock (#7084)", () => {
  it("acquires a free lock, records owner metadata, and releases it", async () => {
    resetProcessLifecycleForTesting();
    const { repoPath, lockPath } = tempRepoPath();
    const release = await acquireRepoCloneLock(repoPath);
    expect(existsSync(lockPath)).toBe(true);
    const meta = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(meta.pid).toBe(process.pid);
    expect(meta.host).toBe(hostname());
    expect(cleanupResourceCount()).toBe(1); // registered for crash-safe release
    release();
    expect(existsSync(lockPath)).toBe(false);
    expect(cleanupResourceCount()).toBe(0); // unregistered on release
  });

  it("release is idempotent", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    const release = await acquireRepoCloneLock(repoPath);
    release();
    expect(() => release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release leaves a lock intact once a peer has reclaimed and re-acquired it", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    const release = await acquireRepoCloneLock(repoPath);
    // Simulate a peer reclaiming us as stale and taking the lock: the file now carries a DIFFERENT token.
    writeFileSync(lockPath, JSON.stringify({ host: hostname(), pid: process.pid, at: at1000, token: "peer-token" }));
    release();
    expect(existsSync(lockPath)).toBe(true); // must not delete the peer's live lock
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("peer-token");
  });

  it("release is a no-op when its lockfile is already gone or unrecognizable", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    const releaseGone = await acquireRepoCloneLock(repoPath);
    rmSync(lockPath, { force: true }); // vanished under us
    expect(() => releaseGone()).not.toThrow();

    const releaseForeign = await acquireRepoCloneLock(repoPath); // re-acquire cleanly
    writeFileSync(lockPath, "null"); // valid JSON but not an owner record
    releaseForeign();
    expect(existsSync(lockPath)).toBe(true); // untouched (not ours)
  });

  it("serializes a second acquirer against the same repo until the first releases", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    // A uses the real clock so its lock reads as fresh (not age-stale) to B, forcing B to wait rather than reclaim.
    const releaseA = await acquireRepoCloneLock(repoPath);

    let bAcquired = false;
    const pendingB = acquireRepoCloneLock(repoPath, { lockSleep: async () => {}, lockPollMs: 1, isProcessAlive: () => true }).then(
      (release) => {
        bAcquired = true;
        return release;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(bAcquired).toBe(false); // blocked while A holds

    releaseA();
    const releaseB = await pendingB;
    expect(bAcquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true); // B now holds it
    releaseB();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("waits out a live holder using the default sleep, then acquires", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    const releaseA = await acquireRepoCloneLock(repoPath);
    // No injected sleep here: exercises the real defaultLockSleep timer on the contended path.
    const pendingB = acquireRepoCloneLock(repoPath, { lockPollMs: 5, isProcessAlive: () => true });
    setTimeout(() => releaseA(), 30);
    const releaseB = await pendingB;
    expect(existsSync(lockPath)).toBe(true);
    releaseB();
  });

  it("fails closed with repo_clone_lock_timeout when a live holder never releases", async () => {
    const { repoPath } = tempRepoPath();
    const releaseA = await acquireRepoCloneLock(repoPath, { nowMs: () => 1000 });
    const clock = [1000, 1300, 1300];
    let i = 0;
    await expect(
      acquireRepoCloneLock(repoPath, {
        nowMs: () => clock[Math.min(i++, clock.length - 1)]!,
        lockTimeoutMs: 100,
        lockStaleMs: 900_000,
        lockSleep: async () => {},
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow("repo_clone_lock_timeout");
    releaseA();
  });

  it("reclaims a stale (dead-owner) lock left by a crashed process and acquires", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: 4242, at: at1000 });
    const release = await acquireRepoCloneLock(repoPath, { isProcessAlive: () => false, lockStaleMs: 5000, nowMs: () => 1500 });
    const meta = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(meta.pid).toBe(process.pid); // reclaimed and re-owned
    release();
  });

  it("REGRESSION (#9681): POLLS a fresh empty peer lock (within grace) instead of reclaiming and re-acquiring it", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    writeLockFile(lockPath, ""); // a peer's freshly-created, not-yet-owner-written 0-byte lock
    const now = 5_000_000;
    const sleeps: number[] = [];
    let opens = 0;
    const release = await acquireRepoCloneLock(repoPath, {
      nowMs: () => now,
      lockPollMs: 7,
      lockSleep: async (ms) => {
        sleeps.push(ms);
        // The peer finishes its acquisition and releases after our first poll, so our retry can take the lock.
        rmSync(lockPath, { force: true });
      },
      openLock: (path) => {
        opens += 1;
        if (opens === 1) {
          const error = new Error("EEXIST") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error; // the peer holds the freshly-created empty lock
        }
        return openSync(path, "wx", 0o600);
      },
      // mtime == now -> the empty peer lock is inside the incomplete-grace window -> NOT stale.
      statLock: () => ({ mtimeMs: now }),
      isProcessAlive: () => true,
    });
    // Before the fix the empty lock read as stale, so acquire UNLINKED it and `continue`d WITHOUT sleeping.
    expect(sleeps).toEqual([7]); // it polled instead of reclaiming
    expect(opens).toBe(2); // retried after the poll
    release();
  });

  it("REGRESSION (#9681): reclaims an over-grace empty lock through the real default statLock (statSync) path", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    writeLockFile(lockPath, ""); // an abandoned 0-byte lock a crashed peer left mid-acquire
    // No injected statLock/openLock: exercises the real default statSync-backed incomplete-lock check. The real
    // file mtime is ~now, so an injected clock well past the grace window makes the default check reclaim it.
    const future = Date.now() + DEFAULT_LOCK_INCOMPLETE_GRACE_MS + 60_000;
    const release = await acquireRepoCloneLock(repoPath, { nowMs: () => future, isProcessAlive: () => true });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid); // reclaimed and re-owned
    release();
  });

  it("rethrows a non-EEXIST open error and a non-Error thrown value", async () => {
    const { repoPath } = tempRepoPath();
    await expect(
      acquireRepoCloneLock(repoPath, {
        openLock: () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      }),
    ).rejects.toThrow("permission denied");
    await expect(
      acquireRepoCloneLock(repoPath, {
        openLock: () => {
          throw null; // a thrown non-object must not crash the guard
        },
      }),
    ).rejects.toBeNull();
  });

  it("cleans up its own just-created lock if writing the metadata fails", async () => {
    const { repoPath, lockPath } = tempRepoPath();
    await expect(
      acquireRepoCloneLock(repoPath, {
        writeLock: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(existsSync(lockPath)).toBe(false); // not left wedged
  });

  it("ensureRepoCloned takes and releases the cross-process lock around its git mutations", async () => {
    const { root, repoPath, lockPath } = tempRepoPath();
    const calls: string[][] = [];
    const runGit = async (args: string[]) => {
      // The lock must be held while git runs: assert its lockfile exists during the mutation.
      expect(existsSync(lockPath)).toBe(true);
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir: root, runGit });
    expect(result.ok).toBe(true);
    expect(result.repoPath).toBe(repoPath);
    expect(calls[0]?.[0]).toBe("clone"); // first-use clone ran under the lock
    expect(existsSync(lockPath)).toBe(false); // released once the sequence completes
  });

  it("is released by closeAllCleanupResources when the process dies mid-clone", async () => {
    resetProcessLifecycleForTesting();
    const { repoPath, lockPath } = tempRepoPath();
    await acquireRepoCloneLock(repoPath);
    expect(cleanupResourceCount()).toBe(1);
    closeAllCleanupResources(); // what installCliSignalHandlers invokes on SIGINT/SIGTERM
    expect(cleanupResourceCount()).toBe(0);
    expect(existsSync(lockPath)).toBe(false); // crash-released, not wedged for the next process
  });
});
