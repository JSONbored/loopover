import { join } from "node:path";
import { removeWorktree } from "@loopover/engine";
import { openLocalStoreDb, resolveLocalStoreDbPath, normalizeLocalStoreDbPath } from "./local-store.js";

// Freeze/snapshot mechanism for historical replay targets (#3010). Given a repo and a commit SHA T, exports:
//  (a) the full working tree checked out AT T via a DETACHED git worktree -- the same isolation primitive
//      worktree-allocator.ts (#4269) uses for attempt isolation, just detached rather than on a new branch,
//      since a replay target is read-only, never a place to commit -- so it never mutates the caller's own
//      checkout/branch.
//  (b) a context bundle: commit history up to and including T (by ANCESTRY, via `git log T` -- walking the DAG
//      is the tamper-resistant way to bound "up to T", since a commit's committer date is user-controlled and
//      can't be trusted alone), tags reachable from T (`git tag --merged T`), and the README as it existed at
//      T (`git ls-tree` + `git show T:<name>`, matched case-insensitively rather than a guessed filename list).
//
// REUSE NOTE: this issue's own text frames "the discover and analyze phases... already read git history" as
// the reuse starting point. Grepped both packages (git log/git tag/commits/tags/releases) before writing this
// and found no such utility anywhere -- opportunity-fanout.js reads GitHub API issue `updated_at`, not git
// commit/tag history at all. The one genuinely reusable piece is worktree-allocator.ts's injected-exec
// convention (WorktreeExecFn) and its removeWorktree -- both reused directly below (import from
// @loopover/engine), rather than inventing a THIRD "inject the git subprocess" abstraction
// alongside cli-subprocess-driver.ts's and worktree-allocator.ts's own.
//
// FAIL-FAST VALIDATION: ancestry-walking (git log T) already excludes anything NOT reachable from T by
// construction, but a tag can point at a commit that IS an ancestor of T while the TAG's own creation/tagger
// date is LATER (e.g. a tag added long after the commit it points to), and commit committer-dates are not
// strictly monotonic along the DAG in general (rebases, clock skew). So checking every exported commit's date
// and every exported tag's date against T's own commit date is a genuine, not merely defensive, check.
//
// PERSISTENCE: the context bundle is cached in the local store, UNIQUE-keyed on (repo_full_name, commit_sha) --
// re-exporting the same (repo, T) pair returns the identical cached row rather than re-running git, which is
// both how "byte-reproducible" holds trivially and avoids redundant work on repeat replay runs. The working-
// tree export itself is git-content-addressed already (the same commit SHA always checks out identical files).

const defaultDbFileName = "replay-snapshot.sqlite3";
let defaultDb = null;

export function resolveReplaySnapshotDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_REPLAY_SNAPSHOT_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolveReplaySnapshotDbPath(), "invalid_replay_snapshot_db_path");
}

const FIELD_SEP = "\x1f";
const README_NAME_PATTERN = /^readme(\.\w+)?$/i;

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeCommitSha(commitSha) {
  if (typeof commitSha !== "string" || !commitSha.trim()) throw new Error("invalid_commit_sha");
  return commitSha.trim();
}

/** Worktree exports live under this dir inside the repo, mirroring worktree-allocator.ts's WORKTREE_SUBDIR. */
export const REPLAY_SNAPSHOT_SUBDIR = ".gittensory-replay-snapshots";

/** PURE: the deterministic on-disk location for a (repo, commit) replay export -- same pair -> same path. */
export function planReplaySnapshotPath(input) {
  const commitSha = normalizeCommitSha(input.commitSha);
  return join(input.repoPath, REPLAY_SNAPSHOT_SUBDIR, commitSha);
}

function assertExecResult(result, description) {
  if (result.code !== 0) {
    const detail = (result.stderr ?? "").trim() || `exit_${result.code}`;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout ?? "";
}

/** Detached checkout at commitSha via `git worktree add --detach` -- never creates a branch, never touches the
 *  caller's own checkout. Idempotent in effect: `git worktree add` itself fails if the path already has a
 *  worktree, which callers avoid by checking the store cache first (see exportReplaySnapshot). */
async function addDetachedWorktree(exec, repoPath, worktreePath, commitSha) {
  const result = await exec("git", ["worktree", "add", "--detach", worktreePath, commitSha], { cwd: repoPath });
  assertExecResult(result, "git_worktree_add_failed");
}

async function readTargetCommitDate(exec, repoPath, commitSha) {
  const result = await exec("git", ["log", "-1", "--format=%cI", commitSha], { cwd: repoPath });
  const stdout = assertExecResult(result, "git_log_target_failed").trim();
  if (!stdout) throw new Error(`git_log_target_failed: no commit found for ${commitSha}`);
  return stdout;
}

async function readCommitHistory(exec, repoPath, commitSha) {
  const result = await exec("git", ["log", commitSha, `--format=%H${FIELD_SEP}%cI${FIELD_SEP}%s`], { cwd: repoPath });
  const stdout = assertExecResult(result, "git_log_history_failed");
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, subject] = line.split(FIELD_SEP);
      return { sha, date, subject: subject ?? "" };
    });
}

// Lightweight tags have no tag object of their own, so `%(creatordate)` falls back to the POINTED-TO commit's
// date rather than a genuine tag-creation date -- git has no record of when a lightweight tag was actually
// created at all. That means a lightweight tag added long after T, but pointing at an ancestor of T, would
// silently pass validateSnapshotFreshness's date check every time (its reported "date" is always <= T's, by
// construction of --merged). Since this can never be verified, lightweight tags are excluded from the export
// entirely -- `%(objecttype)` is "tag" only for an annotated tag's own tag object, "commit" for a lightweight
// tag's direct target, which is how the two are told apart.
async function readReachableTags(exec, repoPath, commitSha) {
  const result = await exec(
    "git",
    ["tag", "--merged", commitSha, `--format=%(refname:short)${FIELD_SEP}%(creatordate:iso-strict)${FIELD_SEP}%(objectname)${FIELD_SEP}%(objecttype)`],
    { cwd: repoPath },
  );
  const stdout = assertExecResult(result, "git_tag_merged_failed");
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, date, targetSha, objectType] = line.split(FIELD_SEP);
      return { name, date, targetSha, objectType };
    })
    .filter((tag) => tag.objectType === "tag")
    .map(({ objectType, ...tag }) => tag);
}

/** Finds the repo-root README (any casing/extension) at commitSha and returns its content, or null if none
 *  exists at that commit. Uses `git ls-tree` to find the real filename rather than guessing a fixed spelling
 *  list. */
async function readReadmeAtCommit(exec, repoPath, commitSha) {
  const listing = await exec("git", ["ls-tree", "--name-only", commitSha], { cwd: repoPath });
  const stdout = assertExecResult(listing, "git_ls_tree_failed");
  const filename = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => README_NAME_PATTERN.test(line));
  if (!filename) return null;

  const shown = await exec("git", ["show", `${commitSha}:${filename}`], { cwd: repoPath });
  const content = assertExecResult(shown, "git_show_readme_failed");
  return { filename, content };
}

/** PURE: fails fast (throws) if any exported commit or tag carries a date LATER than the target commit's own
 *  date. Returns nothing on success. */
export function validateSnapshotFreshness(input) {
  const targetMs = Date.parse(input.targetDate);
  const violations = [];
  for (const commit of input.commits) {
    if (Date.parse(commit.date) > targetMs) violations.push(`commit ${commit.sha} dated ${commit.date} is after target ${input.targetDate}`);
  }
  for (const tag of input.tags) {
    if (Date.parse(tag.date) > targetMs) violations.push(`tag ${tag.name} dated ${tag.date} is after target ${input.targetDate}`);
  }
  if (violations.length > 0) throw new Error(`replay_snapshot_freshness_violation: ${violations.join("; ")}`);
}

export function openReplaySnapshotStore(dbPath = resolveReplaySnapshotDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      target_date TEXT NOT NULL,
      commits_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      readme_filename TEXT,
      readme_content TEXT,
      exported_at TEXT NOT NULL,
      UNIQUE (repo_full_name, commit_sha)
    )
  `);
  const getStatement = db.prepare("SELECT * FROM replay_snapshots WHERE repo_full_name = ? AND commit_sha = ?");
  const insertStatement = db.prepare(`
    INSERT INTO replay_snapshots
      (repo_full_name, commit_sha, worktree_path, target_date, commits_json, tags_json, readme_filename, readme_content, exported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function rowToSnapshot(row) {
    return {
      repoFullName: row.repo_full_name,
      commitSha: row.commit_sha,
      worktreePath: row.worktree_path,
      targetDate: row.target_date,
      commits: JSON.parse(row.commits_json),
      tags: JSON.parse(row.tags_json),
      readme: row.readme_filename ? { filename: row.readme_filename, content: row.readme_content } : null,
      exportedAt: row.exported_at,
    };
  }

  return {
    dbPath: resolvedPath,
    getSnapshot(repoFullName, commitSha) {
      const row = getStatement.get(normalizeRepoFullName(repoFullName), normalizeCommitSha(commitSha));
      return row ? rowToSnapshot(row) : null;
    },
    saveSnapshot(snapshot) {
      const repoFullName = normalizeRepoFullName(snapshot.repoFullName);
      const commitSha = normalizeCommitSha(snapshot.commitSha);
      insertStatement.run(
        repoFullName,
        commitSha,
        snapshot.worktreePath,
        snapshot.targetDate,
        JSON.stringify(snapshot.commits),
        JSON.stringify(snapshot.tags),
        snapshot.readme?.filename ?? null,
        snapshot.readme?.content ?? null,
        new Date().toISOString(),
      );
      return this.getSnapshot(repoFullName, commitSha);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultReplaySnapshotStore() {
  defaultDb ??= openReplaySnapshotStore();
  return defaultDb;
}

export function closeDefaultReplaySnapshotStore() {
  if (!defaultDb) return;
  defaultDb.close();
  defaultDb = null;
}

/**
 * Export a frozen, reproducible replay snapshot for (repoFullName, commitSha): a detached working-tree checkout
 * at that commit plus a context bundle (commit history, reachable tags, README-at-commit). Returns the CACHED
 * snapshot without touching git again if one already exists for this exact (repo, commit) pair.
 *
 * @param {{ repoPath: string, repoFullName: string, commitSha: string }} input
 * @param {{ exec: import("./worktree-allocator.js").WorktreeExecFn, store?: ReturnType<typeof openReplaySnapshotStore> }} deps
 */
export async function exportReplaySnapshot(input, deps) {
  if (!input || typeof input !== "object") throw new Error("invalid_replay_snapshot_input");
  const repoFullName = normalizeRepoFullName(input.repoFullName);
  const commitSha = normalizeCommitSha(input.commitSha);
  if (typeof input.repoPath !== "string" || !input.repoPath.trim()) throw new Error("invalid_repo_path");
  const repoPath = input.repoPath.trim();

  if (!deps || typeof deps !== "object" || typeof deps.exec !== "function") throw new Error("invalid_exec");
  const { exec } = deps;
  const store = deps.store ?? getDefaultReplaySnapshotStore();

  const cached = store.getSnapshot(repoFullName, commitSha);
  if (cached) return cached;

  const worktreePath = planReplaySnapshotPath({ repoPath, commitSha });
  await addDetachedWorktree(exec, repoPath, worktreePath, commitSha);

  // Everything below can fail (a bad git read, or a deliberate freshness violation) after the worktree already
  // exists on disk at the deterministic path above. Left behind, a retry for the same (repo, commit) pair would
  // hit `git worktree add`'s own "path already exists" refusal instead of the real error, permanently masking
  // it. Clean up the worktree on any failure here before rethrowing, so a retry starts from a clean slate.
  try {
    const targetDate = await readTargetCommitDate(exec, repoPath, commitSha);
    const commits = await readCommitHistory(exec, repoPath, commitSha);
    const tags = await readReachableTags(exec, repoPath, commitSha);
    const readme = await readReadmeAtCommit(exec, repoPath, commitSha);

    validateSnapshotFreshness({ targetDate, commits, tags });

    return store.saveSnapshot({ repoFullName, commitSha, worktreePath, targetDate, commits, tags, readme });
  } catch (error) {
    await removeReplaySnapshotWorktree(exec, repoPath, worktreePath).catch(() => {
      /* best-effort cleanup -- the original error below is the one that matters to the caller */
    });
    throw error;
  }
}

/** Tear down a replay snapshot's working-tree export (the cached context-bundle row is left in place -- it is
 *  cheap, commit-keyed, and re-usable even after the on-disk tree is removed; only re-adding the worktree would
 *  require the tree again, which is out of this function's scope). */
export async function removeReplaySnapshotWorktree(exec, repoPath, worktreePath) {
  return removeWorktree({ exec, repoPath, worktreePath });
}
