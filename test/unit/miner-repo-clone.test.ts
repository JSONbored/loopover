import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRepoCloneLock, ensureRepoCloned, isRepoCloneLockStale, parseRepoCloneLock, resolveRepoCloneBaseDir, resolveRepoCloneDir } from "../../packages/loopover-miner/lib/repo-clone.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

/** A real local git repo (main branch, one commit) to act as a clone "origin" without touching the network. */
function initOriginRepo(root: string) {
  const originPath = join(root, "origin");
  execFileSync("git", ["init", "--initial-branch=main", originPath], { stdio: "ignore" });
  writeFileSync(join(originPath, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: originPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: originPath, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
  return originPath;
}

function commitFile(originPath: string, fileName: string, content: string) {
  writeFileSync(join(originPath, fileName), content);
  execFileSync("git", ["add", fileName], { cwd: originPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", `add ${fileName}`], { cwd: originPath, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
}

describe("resolveRepoCloneBaseDir / resolveRepoCloneDir (#5132)", () => {
  it("resolves from explicit env, config dir, and XDG default, in precedence order", () => {
    expect(resolveRepoCloneBaseDir({ LOOPOVER_MINER_REPO_CLONE_DIR: "/custom/repos" })).toBe("/custom/repos");
    expect(resolveRepoCloneBaseDir({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/repos");
    expect(resolveRepoCloneDir("acme/widgets", { LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/repos/acme/widgets");
  });

  it("rejects a malformed repoFullName", () => {
    expect(() => resolveRepoCloneDir("not-a-repo")).toThrow("invalid_repo_full_name");
  });

  it("REGRESSION: rejects '.'/'..' path-traversal segments in owner or repo, in either position", () => {
    expect(() => resolveRepoCloneDir("../foo")).toThrow("invalid_repo_full_name");
    expect(() => resolveRepoCloneDir("foo/..")).toThrow("invalid_repo_full_name");
    expect(() => resolveRepoCloneDir("./foo")).toThrow("invalid_repo_full_name");
    expect(() => resolveRepoCloneDir("foo/.")).toThrow("invalid_repo_full_name");
    expect(() => resolveRepoCloneDir("../..")).toThrow("invalid_repo_full_name");
  });

  it("rejects an owner or repo segment with characters outside GitHub's allowed set", () => {
    expect(() => resolveRepoCloneDir("acme/wid gets")).toThrow("invalid_repo_full_name");
    expect(() => resolveRepoCloneDir("ac me/widgets")).toThrow("invalid_repo_full_name");
  });
});

describe("ensureRepoCloned (#5132)", () => {
  it("clones a real repo on first use, and fetches + hard-resets an existing clone to pick up new commits", async () => {
    // Nine real, sequential git subprocess spawns (origin init/add/commit, the first ensureRepoCloned's
    // clone, a second origin commit, and the second ensureRepoCloned's fetch+checkout+reset) --
    // legitimately more wall-clock latency than the default 15s test timeout reliably covers under
    // concurrent full-suite load (passes in well under 1s in isolation; the same class of flake fixed for
    // test/unit/agent-sdk-driver.test.ts's real-git-subprocess test).
    const root = tempRoot("loopover-miner-repo-clone-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");

    const first = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });
    expect(first.ok).toBe(true);
    expect(first.repoPath).toBe(join(cloneBaseDir, "acme", "widgets"));
    expect(readFileSync(join(first.repoPath, "README.md"), "utf8")).toBe("hello\n");

    // A local edit that was never committed -- the second call's hard-reset must discard it, not preserve it.
    writeFileSync(join(first.repoPath, "README.md"), "locally modified, should be discarded\n");

    commitFile(originPath, "second.txt", "second file\n");

    const second = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });
    expect(second.ok).toBe(true);
    expect(readFileSync(join(second.repoPath, "README.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(second.repoPath, "second.txt"), "utf8")).toBe("second file\n");
  }, 60000);

  it("respects a non-default baseBranch on the fetch+reset path", async () => {
    // Ten real, sequential git subprocess spawns (origin init/add/commit, the branch checkout, the first
    // ensureRepoCloned's clone, the second commitFile's add/commit, and the second ensureRepoCloned's
    // fetch+checkout+reset) -- legitimately more wall-clock latency than the default 15s test timeout
    // reliably covers under concurrent full-suite load (passes in well under 1s in isolation; the same
    // class of flake fixed for test/unit/agent-sdk-driver.test.ts's real-git-subprocess test).
    const root = tempRoot("loopover-miner-repo-clone-branch-");
    const originPath = initOriginRepo(root);
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: originPath, stdio: "ignore" });
    const cloneBaseDir = join(root, "cache");

    const first = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, baseBranch: "develop" });
    expect(first.ok).toBe(true);

    commitFile(originPath, "develop-only.txt", "develop content\n");
    const second = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, baseBranch: "develop" });
    expect(second.ok).toBe(true);
    expect(readFileSync(join(second.repoPath, "develop-only.txt"), "utf8")).toBe("develop content\n");
  }, 60000);

  it("rejects a malformed repoFullName", async () => {
    await expect(ensureRepoCloned("not-a-repo")).rejects.toThrow("invalid_repo_full_name");
  });

  it("returns ok:false with the real git stderr when the clone URL doesn't resolve", async () => {
    const root = tempRoot("loopover-miner-repo-clone-fail-");
    const cloneBaseDir = join(root, "cache");
    const result = await ensureRepoCloned("acme/does-not-exist", { cloneBaseDir, remoteUrl: join(root, "nonexistent-origin"), timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns ok:false on a fetch failure without touching the existing clone (injected runGit)", async () => {
    // Real origin init + a real clone before the injected-runGit assertion. See the first test in this
    // block for why this needs an explicit timeout.
    const root = tempRoot("loopover-miner-repo-clone-fetchfail-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");
    const first = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });
    expect(first.ok).toBe(true);

    const runGit = async (args: string[]) => (args[0] === "fetch" ? { ok: false, stdout: "", stderr: "network unreachable" } : { ok: true, stdout: "", stderr: "" });
    const second = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, runGit });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("network unreachable");
  }, 60000);

  it("returns ok:false on a checkout failure and a reset failure (injected runGit)", async () => {
    // Real origin init + a real clone before the injected-runGit assertions. See the first test in this
    // block for why this needs an explicit timeout.
    const root = tempRoot("loopover-miner-repo-clone-checkoutfail-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");
    await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });

    const checkoutFails = async (args: string[]) => (args[0] === "checkout" ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "" });
    const checkoutResult = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, runGit: checkoutFails });
    expect(checkoutResult.ok).toBe(false);
    expect(checkoutResult.error).toBe("git_checkout_failed");

    const resetFails = async (args: string[]) => (args[0] === "reset" ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "" });
    const resetResult = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, runGit: resetFails });
    expect(resetResult.ok).toBe(false);
    expect(resetResult.error).toBe("git_reset_failed");
  }, 60000);

  it("returns ok:false with a fallback error message on a clone failure with no stderr (injected runGit)", async () => {
    const root = tempRoot("loopover-miner-repo-clone-nostderr-");
    const cloneBaseDir = join(root, "cache");
    const runGit = async () => ({ ok: false, stdout: "", stderr: "" });
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("git_clone_failed");
  });

  it("rejects a dash-prefixed baseBranch before invoking git (#5923)", async () => {
    // Real origin init + a real clone before the injected-runGit assertion. See the first test in this
    // block for why this needs an explicit timeout.
    const root = tempRoot("loopover-miner-repo-clone-unsafe-branch-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");
    await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });

    let runGitCalls = 0;
    const runGit = async () => {
      runGitCalls += 1;
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, baseBranch: "--force", runGit });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_base_branch");
    expect(runGitCalls).toBe(0);
  }, 60000);

  it("rejects a dash-prefixed remoteUrl before invoking git (#5923)", async () => {
    const root = tempRoot("loopover-miner-repo-clone-unsafe-url-");
    const cloneBaseDir = join(root, "cache");
    let runGitCalls = 0;
    const runGit = async () => {
      runGitCalls += 1;
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "--upload-pack=evil", runGit });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_remote_url");
    expect(runGitCalls).toBe(0);
  });
});

describe("ensureRepoCloned per-repo concurrency guard (#6762)", () => {
  // Drains the microtask queue: a setImmediate callback only fires once no microtasks remain ready, so
  // awaiting this lets every already-schedulable git op run while leaving anything still blocked on a gate
  // (or queued behind the mutex) untouched.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("REGRESSION: serializes two concurrent ensureRepoCloned calls for the SAME repo (no interleaved git ops)", async () => {
    // Both concurrent calls share one injected runGit whose first invocation blocks on `firstGate`. WITHOUT
    // the per-repo mutex the second call enters its own git op immediately and `events` shows two
    // "start:clone" before either ends; WITH the guard the second cannot start any git op until the first
    // fully settles, so exactly one op is ever in flight.
    const root = tempRoot("loopover-miner-repo-clone-concurrent-same-");
    const cloneBaseDir = join(root, "cache");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstBlocked = false;
    const runGit = async (args: string[]) => {
      events.push(`start:${args[0]}`);
      if (!firstBlocked) {
        firstBlocked = true;
        await firstGate;
      }
      events.push(`end:${args[0]}`);
      return { ok: true, stdout: "", stderr: "" };
    };

    const first = ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit });
    const second = ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit });

    // Only the first call may have reached git; the second must be queued behind the per-repo lock.
    await flush();
    expect(events).toEqual(["start:clone"]);

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    // Strict, non-overlapping ordering: first runs start->end fully before second starts.
    expect(events).toEqual(["start:clone", "end:clone", "start:clone", "end:clone"]);
  });

  it("does NOT serialize across DIFFERENT repos -- they run in parallel", async () => {
    // repo-a's git op blocks; repo-b's must still proceed (different repoPath => different lock), proving the
    // guard is per-repo rather than a single global mutex.
    const root = tempRoot("loopover-miner-repo-clone-concurrent-diff-");
    const cloneBaseDir = join(root, "cache");
    const started: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const runGitFor = (name: string) => async () => {
      started.push(name);
      if (name === "a") await gateA;
      return { ok: true, stdout: "", stderr: "" };
    };

    const a = ensureRepoCloned("acme/repo-a", { cloneBaseDir, remoteUrl: "unused", runGit: runGitFor("a") });
    const b = ensureRepoCloned("acme/repo-b", { cloneBaseDir, remoteUrl: "unused", runGit: runGitFor("b") });

    await flush();
    // repo-b advanced into git even though repo-a is still blocked -> not serialized against each other.
    expect(started).toContain("b");

    releaseA();
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult.ok).toBe(true);
    expect(bResult.ok).toBe(true);
  });

  it("releases the per-repo lock when a call throws, so a later same-repo call still proceeds", async () => {
    const root = tempRoot("loopover-miner-repo-clone-concurrent-throw-");
    const cloneBaseDir = join(root, "cache");
    const throwing = async () => {
      throw new Error("git exploded");
    };
    await expect(ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit: throwing })).rejects.toThrow("git exploded");

    // If the lock were not released on throw, this second call would block forever (test would time out).
    const ok = async () => ({ ok: true, stdout: "", stderr: "" });
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit: ok });
    expect(result.ok).toBe(true);
  });

  it("keys the lock off the env-resolved base dir when no cloneBaseDir option is given", async () => {
    // Exercises the wrapper's env-fallback path for the lock key (no explicit cloneBaseDir option).
    const root = tempRoot("loopover-miner-repo-clone-concurrent-envdir-");
    const ok = async () => ({ ok: true, stdout: "", stderr: "" });
    const result = await ensureRepoCloned("acme/widgets", { env: { LOOPOVER_MINER_REPO_CLONE_DIR: root }, remoteUrl: "unused", runGit: ok });
    expect(result.ok).toBe(true);
    expect(result.repoPath).toBe(join(root, "acme", "widgets"));
  });

  it("propagates real git stderr and falls back to a default across the fetch/checkout/reset steps", async () => {
    // existsSync(repoPath) true => fetch/checkout/reset path, driven entirely with injected runGit (fast,
    // deterministic). Covers both the real-stderr and empty-stderr fallback branch of each step.
    const root = tempRoot("loopover-miner-repo-clone-concurrent-stderr-");
    const cloneBaseDir = join(root, "cache");
    const repoPath = join(cloneBaseDir, "acme", "widgets");
    mkdirSync(repoPath, { recursive: true });

    const failOn = (step: string, stderr: string) => async (args: string[]) => (args[0] === step ? { ok: false, stdout: "", stderr } : { ok: true, stdout: "", stderr: "" });

    expect((await ensureRepoCloned("acme/widgets", { cloneBaseDir, runGit: failOn("fetch", "") })).error).toBe("git_fetch_failed");
    expect((await ensureRepoCloned("acme/widgets", { cloneBaseDir, runGit: failOn("fetch", "boom-fetch") })).error).toBe("boom-fetch");
    expect((await ensureRepoCloned("acme/widgets", { cloneBaseDir, runGit: failOn("checkout", "boom-checkout") })).error).toBe("boom-checkout");
    expect((await ensureRepoCloned("acme/widgets", { cloneBaseDir, runGit: failOn("reset", "boom-reset") })).error).toBe("boom-reset");
  });
});

type LockFs = {
  open: (path: string) => number;
  write: (fd: number, data: string) => void;
  close: (fd: number) => void;
  read: (path: string) => string;
  unlink: (path: string) => void;
};

/** A filesystem error carrying a `.code`, as Node's fs throws (EEXIST / ENOENT / EPERM / ...). */
function codedError(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("parseRepoCloneLock / isRepoCloneLockStale (#7084)", () => {
  it("parses a well-formed lock payload, keeping a finite pid", () => {
    expect(parseRepoCloneLock(JSON.stringify({ acquiredAtMs: 42, pid: 1234 }))).toEqual({ acquiredAtMs: 42, pid: 1234 });
  });

  it("keeps the timestamp but nulls a missing/non-numeric pid", () => {
    expect(parseRepoCloneLock(JSON.stringify({ acquiredAtMs: 42 }))).toEqual({ acquiredAtMs: 42, pid: null });
    expect(parseRepoCloneLock(JSON.stringify({ acquiredAtMs: 42, pid: "nope" }))).toEqual({ acquiredAtMs: 42, pid: null });
  });

  it("returns null when the timestamp is absent/non-finite or the JSON is corrupt", () => {
    expect(parseRepoCloneLock(JSON.stringify({ pid: 1 }))).toBeNull();
    expect(parseRepoCloneLock("{ not json")).toBeNull();
  });

  it("treats a null (unparseable/vanished) lock as always stale", () => {
    expect(isRepoCloneLockStale(null, 1000, 500)).toBe(true);
  });

  it("treats a parseable lock as stale only once it is older than staleMs", () => {
    expect(isRepoCloneLockStale({ acquiredAtMs: 0 }, 1000, 500)).toBe(true);
    expect(isRepoCloneLockStale({ acquiredAtMs: 600 }, 1000, 500)).toBe(false);
  });
});

describe("acquireRepoCloneLock (#7084)", () => {
  it("acquires immediately when the lockfile does not yet exist, writing an owner record", () => {
    // Real fs against a temp path: proves the happy path creates the file and the release removes it.
    const root = tempRoot("loopover-miner-repo-clone-lock-fresh-");
    const lockPath = join(root, "repo.clone.lock");
    return acquireRepoCloneLock(lockPath).then((release) => {
      const held = parseRepoCloneLock(readFileSync(lockPath, "utf8"));
      expect(held?.pid).toBe(process.pid);
      expect(existsSync(lockPath)).toBe(true);
      release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  it("rethrows an open error that is not EEXIST", async () => {
    const fs: LockFs = { open: () => { throw codedError("EACCES", "denied"); }, write: () => {}, close: () => {}, read: () => "", unlink: () => {} };
    await expect(acquireRepoCloneLock("/whatever.lock", { fs })).rejects.toThrow("denied");
  });

  it("reclaims a stale lock (age > staleMs) then acquires; release is idempotent", async () => {
    let opens = 0;
    let closes = 0;
    const unlinked: string[] = [];
    const fs: LockFs = {
      open: () => {
        opens += 1;
        if (opens === 1) throw codedError("EEXIST");
        return 7;
      },
      write: () => {},
      close: () => {
        closes += 1;
      },
      read: () => JSON.stringify({ pid: 999, acquiredAtMs: 0 }),
      unlink: (path) => {
        unlinked.push(path);
      },
    };
    const release = await acquireRepoCloneLock("/x.clone.lock", { fs, now: () => 1_000_000, staleMs: 100 });
    // The stale lock was removed before the second open succeeded.
    expect(unlinked).toEqual(["/x.clone.lock"]);
    release();
    release(); // idempotent: the guard short-circuits, so close/unlink run exactly once.
    expect(closes).toBe(1);
    expect(unlinked).toEqual(["/x.clone.lock", "/x.clone.lock"]);
  });

  it("waits (sleeps) while a fresh lock is held, then acquires once it is gone", async () => {
    let opens = 0;
    let sleeps = 0;
    const fs: LockFs = {
      open: () => {
        opens += 1;
        if (opens <= 2) throw codedError("EEXIST");
        return 9;
      },
      write: () => {},
      close: () => {},
      read: () => JSON.stringify({ pid: 1, acquiredAtMs: 100 }),
      unlink: () => {},
    };
    const release = await acquireRepoCloneLock("/held.clone.lock", {
      fs,
      now: () => 100, // never advances past the deadline, so the loop keeps waiting rather than timing out
      timeoutMs: 10_000,
      staleMs: 10_000,
      pollMs: 5,
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(sleeps).toBe(2);
    release();
  });

  it("fails closed with repo_clone_lock_timeout when a fresh lock outlives the deadline", async () => {
    const fs: LockFs = {
      open: () => {
        throw codedError("EEXIST");
      },
      write: () => {},
      close: () => {},
      read: () => JSON.stringify({ pid: 1, acquiredAtMs: 0 }),
      unlink: () => {},
    };
    // timeoutMs 0 => deadline == start; the not-stale lock is never reclaimable, so the first pass throws.
    await expect(acquireRepoCloneLock("/busy.clone.lock", { fs, now: () => 0, timeoutMs: 0, staleMs: 10_000_000 })).rejects.toThrow("repo_clone_lock_timeout");
  });

  it("treats a lock whose content vanished mid-check (read throws) as reclaimable", async () => {
    let opens = 0;
    const unlinked: string[] = [];
    const fs: LockFs = {
      open: () => {
        opens += 1;
        if (opens === 1) throw codedError("EEXIST");
        return 4;
      },
      write: () => {},
      close: () => {},
      read: () => {
        throw codedError("ENOENT", "gone");
      },
      unlink: (path) => {
        unlinked.push(path);
      },
    };
    const release = await acquireRepoCloneLock("/vanished.clone.lock", { fs });
    expect(unlinked).toEqual(["/vanished.clone.lock"]);
    release();
  });

  it("ignores ENOENT from the reclaim unlink (another waiter won the race)", async () => {
    let opens = 0;
    const fs: LockFs = {
      open: () => {
        opens += 1;
        if (opens === 1) throw codedError("EEXIST");
        return 2;
      },
      write: () => {},
      close: () => {},
      read: () => JSON.stringify({ acquiredAtMs: 0 }),
      unlink: () => {
        throw codedError("ENOENT");
      },
    };
    const release = await acquireRepoCloneLock("/raced.clone.lock", { fs, now: () => 10_000, staleMs: 1 });
    expect(typeof release).toBe("function");
    release();
  });

  it("surfaces a non-ENOENT unlink error while reclaiming a stale lock", async () => {
    const fs: LockFs = {
      open: () => {
        throw codedError("EEXIST");
      },
      write: () => {},
      close: () => {},
      read: () => "corrupt-not-json", // unparseable => stale => reclaim attempt => unlink throws EPERM
      unlink: () => {
        throw codedError("EPERM", "operation not permitted");
      },
    };
    await expect(acquireRepoCloneLock("/wedged.clone.lock", { fs, staleMs: 0 })).rejects.toThrow("operation not permitted");
  });
});

describe("ensureRepoCloned cross-process lock (#7084)", () => {
  it("REGRESSION: a real on-disk lock blocks a second independent acquirer until the first releases", async () => {
    // The two acquirers share NOTHING but the lockfile itself -- exactly the fleet-mode "sibling containers on a
    // shared volume" model the in-process Map cannot serialize. The second must not acquire while the first holds.
    const root = tempRoot("loopover-miner-repo-clone-xproc-");
    const lockPath = join(root, "repo.clone.lock");
    const first = await acquireRepoCloneLock(lockPath);

    let secondAcquired = false;
    const secondPromise = acquireRepoCloneLock(lockPath, { pollMs: 5 }).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondAcquired).toBe(false); // still blocked on the real lockfile

    first(); // first process releases
    const secondRelease = await secondPromise;
    expect(secondAcquired).toBe(true);
    secondRelease();
  }, 60000);

  it("returns ok:false with repo_clone_lock_timeout (not a throw) when the cross-process lock can't be taken", async () => {
    // A lock held by a live foreign process that never releases: ensureRepoCloned must fail closed via the
    // { ok:false, error } contract so attempt-worktree.js can mark the attempt failed rather than crash.
    const root = tempRoot("loopover-miner-repo-clone-locktimeout-");
    const cloneBaseDir = join(root, "cache");
    const heldFs: LockFs = {
      open: () => {
        throw codedError("EEXIST");
      },
      write: () => {},
      close: () => {},
      read: () => JSON.stringify({ pid: 1, acquiredAtMs: 0 }),
      unlink: () => {},
    };
    const result = await ensureRepoCloned("acme/widgets", {
      cloneBaseDir,
      remoteUrl: "unused",
      lock: { fs: heldFs, now: () => 0, timeoutMs: 0, staleMs: 10_000_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("repo_clone_lock_timeout");
    expect(result.repoPath).toBe(join(cloneBaseDir, "acme", "widgets"));
  });

  it("stringifies a non-Error lock failure into the error field", async () => {
    // The lock fs throws a bare string (not an Error); the { ok:false } contract still surfaces it as a string.
    const root = tempRoot("loopover-miner-repo-clone-locknonerror-");
    const cloneBaseDir = join(root, "cache");
    const nonErrorFs: LockFs = {
      open: () => {
        throw "lock-subsystem-exploded"; // eslint-disable-line no-throw-literal
      },
      write: () => {},
      close: () => {},
      read: () => "",
      unlink: () => {},
    };
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", lock: { fs: nonErrorFs } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("lock-subsystem-exploded");
  });

  it("proceeds past a stale orphaned clone lock left by a crashed process", async () => {
    // A lockfile with an ancient timestamp simulates a process that died mid-clone; a subsequent call must
    // reclaim it and clone rather than wedging forever.
    const root = tempRoot("loopover-miner-repo-clone-staleclone-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");
    mkdirSync(join(cloneBaseDir, "acme"), { recursive: true });
    writeFileSync(join(cloneBaseDir, "acme", "widgets.clone.lock"), JSON.stringify({ pid: 999999, acquiredAtMs: 0 }));

    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, lock: { staleMs: 1 } });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(result.repoPath, "README.md"), "utf8")).toBe("hello\n");
  }, 60000);
});
