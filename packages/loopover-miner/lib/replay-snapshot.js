import { join } from "node:path";
import { removeWorktree } from "@loopover/engine";
import { openLocalStoreDb, resolveLocalStoreDbPath, normalizeLocalStoreDbPath } from "./local-store.js";
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
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeCommitSha(commitSha) {
    if (typeof commitSha !== "string" || !commitSha.trim())
        throw new Error("invalid_commit_sha");
    return commitSha.trim();
}
/** Worktree exports live under this dir inside the repo, mirroring worktree-allocator.ts's WORKTREE_SUBDIR. */
export const REPLAY_SNAPSHOT_SUBDIR = ".loopover-replay-snapshots";
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
    if (!stdout)
        throw new Error(`git_log_target_failed: no commit found for ${commitSha}`);
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
        return { sha: sha, date: date, subject: subject ?? "" };
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
    const result = await exec("git", ["tag", "--merged", commitSha, `--format=%(refname:short)${FIELD_SEP}%(creatordate:iso-strict)${FIELD_SEP}%(objectname)${FIELD_SEP}%(objecttype)`], { cwd: repoPath });
    const stdout = assertExecResult(result, "git_tag_merged_failed");
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
        const [name, date, targetSha, objectType] = line.split(FIELD_SEP);
        return { name: name, date: date, targetSha: targetSha, objectType };
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
    if (!filename)
        return null;
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
        if (Date.parse(commit.date) > targetMs)
            violations.push(`commit ${commit.sha} dated ${commit.date} is after target ${input.targetDate}`);
    }
    for (const tag of input.tags) {
        if (Date.parse(tag.date) > targetMs)
            violations.push(`tag ${tag.name} dated ${tag.date} is after target ${input.targetDate}`);
    }
    if (violations.length > 0)
        throw new Error(`replay_snapshot_freshness_violation: ${violations.join("; ")}`);
}
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
    function getSnapshot(repoFullName, commitSha) {
        const row = getStatement.get(normalizeRepoFullName(repoFullName), normalizeCommitSha(commitSha));
        return row ? rowToSnapshot(row) : null;
    }
    function saveSnapshot(snapshot) {
        const repoFullName = normalizeRepoFullName(snapshot.repoFullName);
        const commitSha = normalizeCommitSha(snapshot.commitSha);
        insertStatement.run(repoFullName, commitSha, snapshot.worktreePath, snapshot.targetDate, JSON.stringify(snapshot.commits), JSON.stringify(snapshot.tags), snapshot.readme?.filename ?? null, snapshot.readme?.content ?? null, new Date().toISOString());
        // Non-null: the INSERT above either succeeded (this row now exists) or threw, so getSnapshot here always
        // finds the row it just wrote.
        return getSnapshot(repoFullName, commitSha);
    }
    return {
        dbPath: resolvedPath,
        getSnapshot,
        saveSnapshot,
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
    if (!defaultDb)
        return;
    defaultDb.close();
    defaultDb = null;
}
/**
 * Export a frozen, reproducible replay snapshot for (repoFullName, commitSha): a detached working-tree checkout
 * at that commit plus a context bundle (commit history, reachable tags, README-at-commit). Returns the CACHED
 * snapshot without touching git again if one already exists for this exact (repo, commit) pair.
 */
export async function exportReplaySnapshot(input, deps) {
    if (!input || typeof input !== "object")
        throw new Error("invalid_replay_snapshot_input");
    const repoFullName = normalizeRepoFullName(input.repoFullName);
    const commitSha = normalizeCommitSha(input.commitSha);
    if (typeof input.repoPath !== "string" || !input.repoPath.trim())
        throw new Error("invalid_repo_path");
    const repoPath = input.repoPath.trim();
    if (!deps || typeof deps !== "object" || typeof deps.exec !== "function")
        throw new Error("invalid_exec");
    const { exec } = deps;
    const store = deps.store ?? getDefaultReplaySnapshotStore();
    const cached = store.getSnapshot(repoFullName, commitSha);
    if (cached)
        return cached;
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
    }
    catch (error) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LXNuYXBzaG90LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVwbGF5LXNuYXBzaG90LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDakMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBRWxELE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSx1QkFBdUIsRUFBRSx5QkFBeUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBcUR4RyxNQUFNLGlCQUFpQixHQUFHLHlCQUF5QixDQUFDO0FBQ3BELElBQUksU0FBUyxHQUErQixJQUFJLENBQUM7QUFFakQsTUFBTSxVQUFVLDJCQUEyQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQy9GLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsbUNBQW1DLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDOUYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsMkJBQTJCLEVBQUUsRUFBRSxpQ0FBaUMsQ0FBQyxDQUFDO0FBQzdHLENBQUM7QUFFRCxNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUM7QUFDekIsTUFBTSxtQkFBbUIsR0FBRyxtQkFBbUIsQ0FBQztBQUVoRCxTQUFTLHFCQUFxQixDQUFDLFlBQW9CO0lBQ2pELElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUNoRixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzVELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxNQUFNLElBQUksS0FB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