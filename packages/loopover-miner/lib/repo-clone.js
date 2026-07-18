import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerCleanupResource } from "./process-lifecycle.js";

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
// serializes calls inside ONE Node process's event loop. DEPLOYMENT.md documents "fleet mode" -- multiple
// container processes sharing the SAME bind-mounted clone volume -- and claim-ledger.js already treats
// "two sibling miner processes racing the same repo" as a real concurrency model. Two fleet workers hitting
// the same repoPath each start with their own empty Map, so #6762's guard does nothing between them: both can
// run `git checkout`/`reset --hard` on the shared working tree at once and corrupt it / trip .git/index.lock.
// An OS-level exclusive lockfile (`open(path, 'wx')` -- an atomic create-or-fail) closes that gap: it is
// visible across processes because the filesystem, not process memory, arbitrates it. The lock records the
// acquiring process's wall-clock so a lock left behind by a crashed process self-expires after `staleMs`
// (mirroring worktree-allocator.js's age-based orphan reclaim), and it is registered as a cleanup resource so
// process-lifecycle.js's SIGINT/SIGTERM handler removes it on a clean exit (mirroring local-store.js).
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LOCK_STALE_MS = 15 * 60_000;
const DEFAULT_LOCK_POLL_MS = 250;

function defaultLockSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real filesystem primitives behind the lock, grouped so tests can inject a deterministic double instead of
// racing real timing. `open` uses the "wx" flag (O_CREAT | O_EXCL): it throws EEXIST when the file already
// exists, which is exactly the atomic "someone else holds the lock" signal.
const defaultLockFs = {
  open: (path) => openSync(path, "wx"),
  write: (fd, data) => writeSync(fd, data),
  close: (fd) => closeSync(fd),
  read: (path) => readFileSync(path, "utf8"),
  unlink: (path) => unlinkSync(path),
};

/**
 * Parse a lockfile's JSON payload back into `{ acquiredAtMs, pid }`, or null when the content is missing,
 * corrupt, or lacks a finite timestamp (all of which mean "no trustworthy owner", so the caller treats it as
 * reclaimable). Exported so the staleness decision is unit-testable without touching the filesystem.
 *
 * @param {string} raw
 * @returns {{ acquiredAtMs: number, pid: number | null } | null}
 */
export function parseRepoCloneLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    const acquiredAtMs = Number(parsed?.acquiredAtMs);
    if (!Number.isFinite(acquiredAtMs)) return null;
    return { acquiredAtMs, pid: Number.isFinite(Number(parsed?.pid)) ? Number(parsed.pid) : null };
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock may be reclaimed: an unparseable lock (crash mid-write, corruption) is always
 * reclaimable, and a parseable one is reclaimable once it is older than `staleMs` -- the self-expiry that stops
 * a crashed holder from wedging every future attempt against that repo forever.
 *
 * @param {{ acquiredAtMs: number } | null} info
 * @param {number} nowMs
 * @param {number} staleMs
 * @returns {boolean}
 */
export function isRepoCloneLockStale(info, nowMs, staleMs) {
  if (info === null) return true;
  return nowMs - info.acquiredAtMs > staleMs;
}

function readExistingLock(fs, lockPath) {
  try {
    return parseRepoCloneLock(fs.read(lockPath));
  } catch {
    // The holder released between our failed `open` and this `read` (TOCTOU): the lock is gone, so it is
    // trivially reclaimable -- fall through to the unlink (a no-op) and retry the `open`.
    return null;
  }
}

function forceUnlinkLock(fs, lockPath) {
  try {
    fs.unlink(lockPath);
  } catch (error) {
    // Another waiter reclaimed the same stale lock first; that is the outcome we wanted, so ignore ENOENT and
    // surface anything else (e.g. EPERM) rather than looping on an unremovable lock.
    if (error?.code !== "ENOENT") throw error;
  }
}

function createLockRelease(fs, lockPath, fd) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unregister();
    fs.close(fd);
    forceUnlinkLock(fs, lockPath);
  };
  // Registered so process-lifecycle.js's SIGINT/SIGTERM/crash handler drops the lockfile on a clean shutdown
  // instead of leaving it for `staleMs` to expire; `release` unregisters itself so the happy path never
  // double-frees.
  const unregister = registerCleanupResource(release);
  return release;
}

/**
 * Take an OS-level exclusive lock on `lockPath`, blocking (bounded by `timeoutMs`) until a holder in ANOTHER
 * process releases it, reclaiming a stale/orphaned lock left by a crashed process, and failing closed with a
 * `repo_clone_lock_timeout` error if it cannot be acquired in time. Returns an idempotent release function.
 * Every dependency (`fs`, `now`, `sleep`, the timeouts) is injectable so all branches are deterministically
 * testable without real cross-process timing.
 *
 * @param {string} lockPath
 * @param {{
 *   timeoutMs?: number, staleMs?: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   fs?: { open: (path: string) => number, write: (fd: number, data: string) => void, close: (fd: number) => void, read: (path: string) => string, unlink: (path: string) => void },
 * }} [options]
 * @returns {Promise<() => void>}
 */
export async function acquireRepoCloneLock(lockPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_LOCK_STALE_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_LOCK_POLL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultLockSleep;
  const fs = options.fs ?? defaultLockFs;

  const deadline = now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = fs.open(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      fs.write(fd, JSON.stringify({ pid: process.pid, acquiredAtMs: now() }));
      return createLockRelease(fs, lockPath, fd);
    }
    if (isRepoCloneLockStale(readExistingLock(fs, lockPath), now(), staleMs)) {
      forceUnlinkLock(fs, lockPath);
      continue;
    }
    if (now() >= deadline) throw new Error("repo_clone_lock_timeout");
    await sleep(pollMs);
  }
}

/**
 * Serialize the git mutations of {@link ensureRepoClonedUnlocked} per resolved repo path so concurrent
 * same-repo attempts never race the shared base clone -- both WITHIN one Node process (the in-process
 * `repoCloneLocks` Map, #6762) and ACROSS separate OS processes such as fleet-mode's sibling containers (an
 * OS-level exclusive lockfile, #7084), while different repos still run fully in parallel. Resolves the same
 * `repoPath` the unlocked step computes and uses it as both the mutex key and the lockfile location; throws
 * (before locking) on a malformed `repoFullName`, matching the prior behaviour.
 *
 * @param {string} repoFullName
 * @param {{
 *   baseBranch?: string, cloneBaseDir?: string, env?: Record<string, string | undefined>, timeoutMs?: number,
 *   remoteUrl?: string, runGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>,
 *   lock?: { timeoutMs?: number, staleMs?: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, fs?: object },
 * }} [options]
 * @returns {Promise<{ ok: boolean, repoPath: string, error?: string }>}
 */
export async function ensureRepoCloned(repoFullName, options = {}) {
  const target = normalizeRepoFullName(repoFullName);
  const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
  const repoPath = join(cloneBaseDir, target.owner, target.repo);
  const lockPath = `${repoPath}.clone.lock`;
  return withRepoCloneLock(repoPath, async () => {
    // The lockfile lives beside the clone, so its parent (cloneBaseDir/owner) must exist before `open` runs --
    // on a first-ever clone that directory hasn't been created yet.
    mkdirSync(join(cloneBaseDir, target.owner), { recursive: true, mode: 0o700 });
    let releaseLock;
    try {
      releaseLock = await acquireRepoCloneLock(lockPath, options.lock ?? {});
    } catch (error) {
      // A lock-acquire failure (timeout on a busy lock, or an fs error taking it) is an operational failure,
      // not a programmer error: surface it via the same { ok:false, error } contract as a git failure so the
      // caller (attempt-worktree.js) fails the attempt closed instead of throwing an unhandled rejection.
      return { ok: false, repoPath, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      return await ensureRepoClonedUnlocked(repoFullName, options);
    } finally {
      releaseLock();
    }
  });
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
