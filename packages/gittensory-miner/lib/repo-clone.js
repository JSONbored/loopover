import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Per-repo base-clone cache (#5132, Wave 3.5 follow-up). packages/gittensory-engine/src/miner/
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
  const explicitPath = typeof env.GITTENSORY_MINER_REPO_CLONE_DIR === "string" ? env.GITTENSORY_MINER_REPO_CLONE_DIR.trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string" ? env.GITTENSORY_MINER_CONFIG_DIR.trim() : "";
  if (explicitConfigDir) return join(explicitConfigDir, DEFAULT_CLONE_DIR_NAME);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME.trim() : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", DEFAULT_CLONE_DIR_NAME);
}

// GitHub owner/repo names are restricted to alphanumerics, hyphens, underscores, and periods, and are never
// exactly "." or ".." -- both are rejected here so a value like "../foo" can't make resolveRepoCloneDir's
// join(cloneBaseDir, owner, repo) escape the intended clone directory (a real path-traversal finding).
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function isPathTraversalSegment(segment) {
  return segment === "." || segment === "..";
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  if (!REPO_SEGMENT_PATTERN.test(owner) || !REPO_SEGMENT_PATTERN.test(repo)) throw new Error("invalid_repo_full_name");
  if (isPathTraversalSegment(owner) || isPathTraversalSegment(repo)) throw new Error("invalid_repo_full_name");
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
export async function ensureRepoCloned(repoFullName, options = {}) {
  const target = normalizeRepoFullName(repoFullName);
  const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : DEFAULT_BASE_BRANCH;
  const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
  const repoPath = join(cloneBaseDir, target.owner, target.repo);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
  const runGit = options.runGit ?? defaultRunGit;

  if (!existsSync(repoPath)) {
    mkdirSync(join(cloneBaseDir, target.owner), { recursive: true, mode: 0o700 });
    const cloneUrl = typeof options.remoteUrl === "string" && options.remoteUrl.trim() ? options.remoteUrl.trim() : `https://github.com/${target.owner}/${target.repo}.git`;
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
