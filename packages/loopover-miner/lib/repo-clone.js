import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerCleanupResource } from "./process-lifecycle.js";
import { isProcessAlive } from "./worktree-allocator.js";

// Per-repo base-clone cache (#5132, Wave 3.5 follow-up). packages/loopover-engine/src/miner/
// worktree-allocator.ts's real `addWorktree` primitive (git worktree add -b <branch> <path> <baseBranch>)
// requires an EXISTING git clone to branch off -- it has never been wired into this package because that
// clone-management step didn't exist yet. This module is that step: clone a target repo once, then keep it
// current (fetch + hard-reset to the base branch) on every subsequent attempt, so `addWorktree` always
// branches off real, fresh content. Relies entirely on whatever git/gh credentials are already configured
// on this machine -- same assumption execute-local-write.js's `gh pr create` already makes; this module
// never embeds a token in a clone URL.

const execFileAsync = promisify(execFile);
const DEFAULT_CLONE_DIR_NAME = "repos";
const DEFAULT_BASE_BRANCH = "main";

export function resolveRepoCloneBaseDir(env = process.env) {
  const explicitPath = typeof env.LOOPOVER_MINER_REPO_CLONE_DIR === "string" ? env.LOOPOVER_MINER_REPO_CLONE_DIR.trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string" ? env.LOOPOVER_MINER_CONFIG_DIR.trim() : "";
  if (explicitConfigDir) return join(explicitConfigDir, DEFAULT_CLONE_DIR_NAME);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME.trim() : join(homedir(), ".config");
  return join(configHome, "loopover-miner", DEFAULT_CLONE_DIR_NAME);
}

// GitHub owner/repo names are restricted to alphanumerics, hyphens, underscores, and periods, and are never
// exactly "." or ".." -- both are rejected here so a value like "../foo" can't make resolveRepoCloneDir's
// join(cloneBaseDir, owner, repo) escape the intended clone directory (a real path-traversal finding).
// Exported so every other owner/repo parser in this package (#5831) shares this one definition instead of
// duplicating it (cross-repo-evaluation.js) or skipping it entirely (attempt-cli.js, claim-ledger-cli.js,
// event-ledger-cli.js, claim-ledger.js).
export const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isPathTraversalSegment(segment) {
  return segment === "." || segment === "..";
}

export function isValidRepoSegment(segment) {
  return typeof segment === "string" && REPO_SEGMENT_PATTERN.test(segment) && !isPathTraversalSegment(segment);
}

// Reject values that git would interpret as options when passed as argv (e.g. `--upload-pack=...`).
function isUnsafeGitArgValue(value) {
  return typeof value === "string" && value.startsWith("-");
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) throw new Error("invalid_repo_full_name");
  return { owner, repo, repoFullName: `${owner}/${repo}` };
}

export function resolveRepoCloneDir(repoFullName, env = process.env) {
  const target = normalizeRepoFullName(repoFullName);
  return join(resolveRepoCloneBaseDir(env), target.owner, target.repo);
}

async function defaultRunGit(args, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return { ok: false, stdout: "", stderr: stderr || (error instanceof Error ? error.message : String(error)) };
  }
}

// Per-repoPath in-process serialization for ensureRepoCloned (#6762). Two attempts for the SAME repo share
// one deterministic base-clone path and mutate it in place (git fetch/checkout/reset --hard); worktree-
// allocator.js only caps the TOTAL active-slot count, never per-repo exclusivity, so without this two
// same-repo attempts can interleave git subprocesses on the same .git dir and corrupt the index/HEAD/refs or
// trip .git/index.lock. `repoCloneLocks` maps a resolved repoPath to the tail of its in-flight promise chain:
// same-repo calls run strictly one after another, while different repoPaths stay fully parallel. The tail
// promise's handlers swallow, so it never rejects -- one failing attempt can neither reject a waiter nor
// wedge the queue -- and the finally drops the entry once the chain drains, keeping the Map bounded.
const repoCloneLocks = new Map();

/**
 * @template T
 * @param {string} repoPath key: the resolved base-clone path the git mutations run against.
 * @param {() => Promise<T>} fn the critical section (a single ensureRepoClonedUnlocked run).
 * @returns {Promise<T>}
 */
async function withRepoCloneLock(repoPath, fn) {
  const previous = repoCloneLocks.get(repoPath) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(
    () => {},
    () => {},
  );
  repoCloneLocks.set(repoPath, tail);
  try {
    return await run;
  } finally {
    if (repoCloneLocks.get(repoPath) === tail) repoCloneLocks.delete(repoPath);
  }
}

// Cross-process serialization for ensureRepoCloned (#7084). The in-process `repoCloneLocks` Map above only
// serializes callers sharing one Node event loop; fleet mode (DEPLOYMENT.md) runs multiple SEPARATE processes --
// distinct containers, no shared memory -- against one bind-mounted clone volume, so two of them can still
// interleave git subprocesses on the same .git dir and corrupt the index/HEAD/refs. An OS-level exclusive lockfile
// (open(.., 'wx')) on a deterministic path derived from repoPath closes that gap: create-and-hold is atomic across
// processes, so exactly one holder mutates the clone while a loser waits (bounded) or fails closed. The lock
// records owner pid+host+timestamp so a holder that CRASHES mid-clone doesn't wedge the repo forever -- a same-host
// dead-owner or an over-age lock is reclaimed (mirroring worktree-allocator.js's stale reclaim), and
// registerCleanupResource unlinks it on SIGINT/SIGTERM like this package's other crash-safe resources (#4826).

const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // comfortably past a slow clone/fetch sequence
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000; // a lock older than this is presumed crashed
const DEFAULT_LOCK_POLL_MS = 100;
const defaultLockSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repoCloneLockPath(repoPath) {
  return `${repoPath}.clone.lock`;
}

/**
 * Decide whether an existing clone lockfile is stale (reclaimable): true when the file is missing or its JSON is
 * unreadable/partial (a crash mid-write), when its owner pid is confirmed dead within the SAME host's namespace,
 * or when it is older than `staleMs` (the host-agnostic backstop for a cross-host/cross-container owner whose pid
 * this host can't probe). A well-formed lock held by a live same-host owner within `staleMs` is NOT stale.
 *
 * @param {string} lockPath
 * @param {number} nowMs
 * @param {number} staleMs
 * @param {(pid: number) => boolean} [isAlive]
 */
export function isRepoCloneLockStale(lockPath, nowMs, staleMs, isAlive = isProcessAlive) {
  let meta;
  try {
    meta = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return true;
  }
  if (!meta || typeof meta !== "object") return true;
  if (meta.host === hostname() && Number.isInteger(meta.pid) && !isAlive(meta.pid)) return true;
  const atMs = Date.parse(meta.at);
  if (!Number.isFinite(atMs)) return true;
  return nowMs - atMs > staleMs;
}

/**
 * Take the cross-process clone lock for `repoPath`, returning an idempotent `release()`. Atomically create-and-holds
 * `${repoPath}.clone.lock` (open .., 'wx'); on contention it reclaims a stale lock (see {@link isRepoCloneLockStale})
 * or waits `lockPollMs` between retries until `lockTimeoutMs` elapses, then throws `repo_clone_lock_timeout` (fail
 * closed). Registered for crash-safe cleanup so a SIGINT/SIGTERM releases it. `nowMs`/`lockSleep`/`isProcessAlive`/
 * `openLock`/`writeLock` are injectable for tests; every real caller relies on the defaults.
 *
 * @param {string} repoPath
 * @param {{ lockTimeoutMs?: number, lockStaleMs?: number, lockPollMs?: number, nowMs?: () => number,
 *   lockSleep?: (ms: number) => Promise<unknown>, isProcessAlive?: (pid: number) => boolean,
 *   openLock?: (lockPath: string) => number, writeLock?: (fd: number, data: string) => void }} [options]
 * @returns {Promise<() => void>}
 */
export async function acquireRepoCloneLock(repoPath, options = {}) {
  const lockPath = repoCloneLockPath(repoPath);
  const timeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS;
  const pollMs = Number.isFinite(options.lockPollMs) ? options.lockPollMs : DEFAULT_LOCK_POLL_MS;
  const now = typeof options.nowMs === "function" ? options.nowMs : Date.now;
  const sleep = typeof options.lockSleep === "function" ? options.lockSleep : defaultLockSleep;
  const isAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : isProcessAlive;
  const openLock = typeof options.openLock === "function" ? options.openLock : (path) => openSync(path, "wx", 0o600);
  const writeLock = typeof options.writeLock === "function" ? options.writeLock : (fd, data) => writeSync(fd, data);

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = openLock(lockPath);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (isRepoCloneLockStale(lockPath, now(), staleMs, isAlive)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another waiter reclaimed it first -- just retry the open.
        }
        continue;
      }
      if (now() >= deadline) throw new Error("repo_clone_lock_timeout");
      await sleep(pollMs);
      continue;
    }
    try {
      writeLock(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(now()).toISOString() }));
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort cleanup of our own just-created lock
      }
      throw error;
    }
    let released = false;
    let unregister = () => {};
    const release = () => {
      if (released) return;
      released = true;
      unregister();
      try {
        closeSync(fd);
      } catch {
        // fd already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // lock already removed (e.g. reclaimed as stale by a peer)
      }
    };
    unregister = registerCleanupResource(release);
    return release;
  }
}

async function withRepoCloneCrossProcessLock(repoPath, options, fn) {
  const release = await acquireRepoCloneLock(repoPath, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Serialize the git mutations of {@link ensureRepoClonedUnlocked} per resolved repo path so concurrent
 * same-repo attempts never race the shared base clone (#6762), while different repos still run in parallel.
 * Resolves the same `repoPath` the unlocked step computes and uses it as the mutex key; throws (before
 * locking) on a malformed `repoFullName`, matching the prior behaviour.
 *
 * @param {string} repoFullName
 * @param {{
 *   baseBranch?: string, cloneBaseDir?: string, env?: Record<string, string | undefined>, timeoutMs?: number,
 *   remoteUrl?: string, runGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>,
 * }} [options]
 * @returns {Promise<{ ok: boolean, repoPath: string, error?: string }>}
 */
export async function ensureRepoCloned(repoFullName, options = {}) {
  const target = normalizeRepoFullName(repoFullName);
  const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
  const repoPath = join(cloneBaseDir, target.owner, target.repo);
  // Two nested locks: the in-process Map (#6762) keeps same-process callers cheap and ordered, and the
  // cross-process lockfile (#7084) additionally serializes separate OS processes sharing the clone volume.
  return withRepoCloneLock(repoPath, () =>
    withRepoCloneCrossProcessLock(repoPath, options, () => ensureRepoClonedUnlocked(repoFullName, options)),
  );
}

/**
 * Ensure a real, current local clone of `repoFullName` exists at the deterministic per-repo cache path.
 * First use: `git clone`. Subsequent use: `git fetch origin` + hard-reset the base branch to
 * `origin/<baseBranch>`, so every attempt branches off fresh content, not a stale prior checkout.
 *
 * @param {string} repoFullName
 * @param {{
 *   baseBranch?: string, cloneBaseDir?: string, env?: Record<string, string | undefined>, timeoutMs?: number,
 *   remoteUrl?: string, runGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>,
 * }} [options]
 * @returns {Promise<{ ok: boolean, repoPath: string, error?: string }>}
 */
async function ensureRepoClonedUnlocked(repoFullName, options = {}) {
  const target = normalizeRepoFullName(repoFullName);
  const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : DEFAULT_BASE_BRANCH;
  const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
  const repoPath = join(cloneBaseDir, target.owner, target.repo);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
  const runGit = options.runGit ?? defaultRunGit;

  if (isUnsafeGitArgValue(baseBranch)) {
    return { ok: false, repoPath, error: "invalid_base_branch" };
  }

  if (!existsSync(repoPath)) {
    mkdirSync(join(cloneBaseDir, target.owner), { recursive: true, mode: 0o700 });
    const cloneUrl = typeof options.remoteUrl === "string" && options.remoteUrl.trim() ? options.remoteUrl.trim() : `https://github.com/${target.owner}/${target.repo}.git`;
    if (isUnsafeGitArgValue(cloneUrl)) {
      return { ok: false, repoPath, error: "invalid_remote_url" };
    }
    const cloned = await runGit(["clone", cloneUrl, repoPath], cloneBaseDir, timeoutMs);
    if (!cloned.ok) return { ok: false, repoPath, error: cloned.stderr || "git_clone_failed" };
    return { ok: true, repoPath };
  }

  const fetched = await runGit(["fetch", "origin"], repoPath, timeoutMs);
  if (!fetched.ok) return { ok: false, repoPath, error: fetched.stderr || "git_fetch_failed" };

  const checkedOut = await runGit(["checkout", baseBranch], repoPath, timeoutMs);
  if (!checkedOut.ok) return { ok: false, repoPath, error: checkedOut.stderr || "git_checkout_failed" };

  const reset = await runGit(["reset", "--hard", `origin/${baseBranch}`], repoPath, timeoutMs);
  if (!reset.ok) return { ok: false, repoPath, error: reset.stderr || "git_reset_failed" };

  return { ok: true, repoPath };
}
