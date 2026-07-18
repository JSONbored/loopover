import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRepoCloneLock, ensureRepoCloned, isRepoCloneLockStale } from "../../packages/loopover-miner/lib/repo-clone.js";
import {
  cleanupResourceCount,
  closeAllCleanupResources,
  resetProcessLifecycleForTesting,
} from "../../packages/loopover-miner/lib/process-lifecycle.js";

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
  it("treats a missing or unreadable lockfile as stale", () => {
    const { lockPath } = tempRepoPath();
    expect(isRepoCloneLockStale(lockPath, 1000, 5000)).toBe(true); // never created
    writeLockFile(lockPath, "{ not valid json");
    expect(isRepoCloneLockStale(lockPath, 1000, 5000)).toBe(true);
  });

  it("treats a non-object payload as stale", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, "null");
    expect(isRepoCloneLockStale(lockPath, 1000, 5000)).toBe(true);
    writeLockFile(lockPath, "123");
    expect(isRepoCloneLockStale(lockPath, 1000, 5000)).toBe(true);
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

  it("keeps a live same-host lock within its age bound, and reclaims it once over-age", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: 4242, at: at1000 });
    expect(isRepoCloneLockStale(lockPath, 1000 + 5000, 5000, () => true)).toBe(false); // age == bound: still fresh
    expect(isRepoCloneLockStale(lockPath, 1000 + 5001, 5000, () => true)).toBe(true); // age > bound
  });

  it("treats an unparseable timestamp as stale", () => {
    const { lockPath } = tempRepoPath();
    writeLockFile(lockPath, { host: hostname(), pid: 4242, at: "not-a-time" });
    expect(isRepoCloneLockStale(lockPath, 1500, 5000, () => true)).toBe(true);
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
