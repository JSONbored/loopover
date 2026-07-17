import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
  return withRepoCloneLock(repoPath, () => ensureRepoClonedUnlocked(repoFullName, options));
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
