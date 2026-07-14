import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeDefaultReplaySnapshotStore,
  exportReplaySnapshot,
  openReplaySnapshotStore,
  planReplaySnapshotPath,
  removeReplaySnapshotWorktree,
  REPLAY_SNAPSHOT_SUBDIR,
  validateSnapshotFreshness,
} from "../../packages/loopover-miner/lib/replay-snapshot.js";

const FIELD_SEP = "\x1f";

type ExecResult = { code: number | null; stdout?: string; stderr?: string };
type ExecCall = { cmd: string; args: readonly string[]; cwd: string };

function scriptedExec(scripts: Array<{ match: (args: readonly string[]) => boolean; result: ExecResult }>) {
  const calls: ExecCall[] = [];
  const exec = async (cmd: string, args: readonly string[], opts: { cwd: string }): Promise<ExecResult> => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const script = scripts.find((s) => s.match(args));
    if (!script) throw new Error(`no script matched: ${args.join(" ")}`);
    return script.result;
  };
  return { exec, calls };
}

const isWorktreeAdd = (args: readonly string[]) => args[0] === "worktree" && args[1] === "add";
const isTargetDate = (args: readonly string[]) => args[0] === "log" && args[1] === "-1";
const isHistory = (args: readonly string[]) => args[0] === "log" && args[1] !== "-1";
const isTag = (args: readonly string[]) => args[0] === "tag";
const isLsTree = (args: readonly string[]) => args[0] === "ls-tree";
const isShow = (args: readonly string[]) => args[0] === "show";

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout };
}

/** A realistic happy-path script set: 1 commit history entry, 1 tag, a found README -- callers override
 *  individual entries (by unshifting a higher-priority match) for other scenarios. */
function happyPathScripts(overrides: Array<{ match: (args: readonly string[]) => boolean; result: ExecResult }> = []) {
  return [
    ...overrides,
    { match: isWorktreeAdd, result: ok() },
    { match: isTargetDate, result: ok("2026-01-05T00:00:00+00:00\n") },
    { match: isHistory, result: ok(`abc123${FIELD_SEP}2026-01-05T00:00:00+00:00${FIELD_SEP}the target commit\n`) },
    { match: isTag, result: ok(`v1.0.0${FIELD_SEP}2026-01-01T00:00:00+00:00${FIELD_SEP}abc000${FIELD_SEP}tag\n`) },
    { match: isLsTree, result: ok("README.md\nsrc\npackage.json\n") },
    { match: isShow, result: ok("# hello\n") },
  ];
}

let stores: Array<{ close(): void }> = [];
let roots: string[] = [];
function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-replay-snapshot-"));
  roots.push(root);
  const store = openReplaySnapshotStore(join(root, "db.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  closeDefaultReplaySnapshotStore();
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("planReplaySnapshotPath (#3010) — pure, deterministic", () => {
  it("same (repoPath, commitSha) always yields the same path", () => {
    const a = planReplaySnapshotPath({ repoPath: "/repo", commitSha: "abc123" });
    expect(a.replaceAll("\\", "/")).toBe(`/repo/${REPLAY_SNAPSHOT_SUBDIR}/abc123`);
    expect(planReplaySnapshotPath({ repoPath: "/repo", commitSha: "abc123" })).toBe(a);
    expect(planReplaySnapshotPath({ repoPath: "/repo", commitSha: "def456" })).not.toBe(a);
  });
});

describe("validateSnapshotFreshness (#3010) — pure fail-fast check", () => {
  const targetDate = "2026-01-05T00:00:00+00:00";

  it("passes when every commit and tag date is at or before the target", () => {
    expect(() =>
      validateSnapshotFreshness({
        targetDate,
        commits: [{ sha: "a", date: targetDate, subject: "t" }, { sha: "b", date: "2026-01-01T00:00:00Z", subject: "s" }],
        tags: [{ name: "v1", date: "2025-12-01T00:00:00Z", targetSha: "b" }],
      }),
    ).not.toThrow();
  });

  it("throws, listing ALL violations, when a commit is dated after the target", () => {
    expect(() =>
      validateSnapshotFreshness({
        targetDate,
        commits: [{ sha: "future1", date: "2026-02-01T00:00:00Z", subject: "s" }],
        tags: [],
      }),
    ).toThrow(/future1 dated 2026-02-01T00:00:00Z is after target/);
  });

  it("throws when a tag is dated after the target, independent of commit dates", () => {
    expect(() =>
      validateSnapshotFreshness({
        targetDate,
        commits: [{ sha: "a", date: targetDate, subject: "t" }],
        tags: [{ name: "v-future", date: "2026-03-01T00:00:00Z", targetSha: "a" }],
      }),
    ).toThrow(/v-future dated 2026-03-01T00:00:00Z is after target/);
  });

  it("lists both a commit AND a tag violation together in one error", () => {
    expect(() =>
      validateSnapshotFreshness({
        targetDate,
        commits: [{ sha: "future1", date: "2026-02-01T00:00:00Z", subject: "s" }],
        tags: [{ name: "v-future", date: "2026-03-01T00:00:00Z", targetSha: "future1" }],
      }),
    ).toThrow(/future1.*v-future|v-future.*future1/s);
  });
});

describe("exportReplaySnapshot (#3010)", () => {
  it("exports a fresh snapshot: worktree, target date, commit history, reachable tags, and README", async () => {
    const { exec } = scriptedExec(happyPathScripts());
    const store = tempStore();

    const snapshot = await exportReplaySnapshot(
      { repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" },
      { exec, store },
    );

    expect(snapshot.repoFullName).toBe("acme/widgets");
    expect(snapshot.commitSha).toBe("abc123");
    expect(snapshot.targetDate).toBe("2026-01-05T00:00:00+00:00");
    expect(snapshot.commits).toEqual([{ sha: "abc123", date: "2026-01-05T00:00:00+00:00", subject: "the target commit" }]);
    expect(snapshot.tags).toEqual([{ name: "v1.0.0", date: "2026-01-01T00:00:00+00:00", targetSha: "abc000" }]);
    expect(snapshot.readme).toEqual({ filename: "README.md", content: "# hello\n" });
  });

  it("returns the cached snapshot on a repeat export of the same (repo, commit) pair, without calling git again", async () => {
    const store = tempStore();
    const first = scriptedExec(happyPathScripts());
    await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec: first.exec, store });

    const second = scriptedExec([]); // no scripts at all -- any call would throw "no script matched"
    const result = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec: second.exec, store });

    expect(result.commits).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  it("a repo with NO tags yields an empty tags array", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isTag, result: ok("") }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.tags).toEqual([]);
  });

  it("a repo with MULTIPLE annotated tags parses every reachable tag", async () => {
    const tagStdout = [
      `v1.0.0${FIELD_SEP}2025-12-01T00:00:00+00:00${FIELD_SEP}sha1${FIELD_SEP}tag`,
      `v1.1.0${FIELD_SEP}2026-01-01T00:00:00+00:00${FIELD_SEP}sha2${FIELD_SEP}tag`,
    ].join("\n") + "\n";
    const { exec } = scriptedExec(happyPathScripts([{ match: isTag, result: ok(tagStdout) }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.tags).toEqual([
      { name: "v1.0.0", date: "2025-12-01T00:00:00+00:00", targetSha: "sha1" },
      { name: "v1.1.0", date: "2026-01-01T00:00:00+00:00", targetSha: "sha2" },
    ]);
  });

  it("excludes a lightweight tag from the export -- its reported date is the pointed-to commit's, not a verifiable tag-creation date", async () => {
    const tagStdout = [
      `v1.0.0${FIELD_SEP}2025-12-01T00:00:00+00:00${FIELD_SEP}sha1${FIELD_SEP}tag`, // annotated -- kept
      `v-lightweight${FIELD_SEP}2026-01-01T00:00:00+00:00${FIELD_SEP}sha2${FIELD_SEP}commit`, // lightweight -- dropped
    ].join("\n") + "\n";
    const { exec } = scriptedExec(happyPathScripts([{ match: isTag, result: ok(tagStdout) }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.tags).toEqual([{ name: "v1.0.0", date: "2025-12-01T00:00:00+00:00", targetSha: "sha1" }]);
  });

  it("a commit at the very first commit of history: git log returns exactly one entry, no parents to walk", async () => {
    const { exec } = scriptedExec(
      happyPathScripts([
        { match: isHistory, result: ok(`root000${FIELD_SEP}2020-01-01T00:00:00+00:00${FIELD_SEP}initial commit\n`) },
        { match: isTargetDate, result: ok("2020-01-01T00:00:00+00:00\n") },
        { match: isTag, result: ok("") }, // no tag can predate the very first commit
      ]),
    );
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "root000" }, { exec, store });

    expect(snapshot.commits).toEqual([{ sha: "root000", date: "2020-01-01T00:00:00+00:00", subject: "initial commit" }]);
  });

  it("no README present at the commit: readme is null, and show is never called for a nonexistent file", async () => {
    const { exec, calls } = scriptedExec(happyPathScripts([{ match: isLsTree, result: ok("src\npackage.json\n") }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.readme).toBeNull();
    expect(calls.some((c) => c.args[0] === "show")).toBe(false);
  });

  it("matches a differently-cased/spelled README (case-insensitive, any extension)", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isLsTree, result: ok("src\nReadme.rst\npackage.json\n") }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.readme?.filename).toBe("Readme.rst");
  });

  it("throws a freshness violation, never persists, AND removes the worktree it already created -- a retry for the same pair must not hit a stale 'path already exists'", async () => {
    const { exec, calls } = scriptedExec(happyPathScripts([{ match: isTag, result: ok(`v-future${FIELD_SEP}2026-06-01T00:00:00+00:00${FIELD_SEP}abc000${FIELD_SEP}tag\n`) }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /replay_snapshot_freshness_violation/,
    );
    expect(store.getSnapshot("acme/widgets", "abc123")).toBeNull();
    const removeCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    expect(removeCall?.args).toEqual(["worktree", "remove", "--force", "/repo/.loopover-replay-snapshots/abc123"]);
  });

  it("removes the worktree and rethrows the ORIGINAL error (not a cleanup error) when a git read after the worktree exists fails", async () => {
    const { exec, calls } = scriptedExec(happyPathScripts([{ match: isHistory, result: { code: 1, stderr: "fatal: history read failed" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_log_history_failed/,
    );
    const removeCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    expect(removeCall).toBeDefined();
  });

  it("still rethrows the original error even when the best-effort cleanup itself fails", async () => {
    const { exec } = scriptedExec(
      happyPathScripts([
        { match: isHistory, result: { code: 1, stderr: "fatal: history read failed" } },
        { match: (args) => args[0] === "worktree" && args[1] === "remove", result: { code: 1, stderr: "fatal: cleanup also failed" } },
      ]),
    );
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_log_history_failed/,
    );
  });

  it("tolerates a successful exec result with no stdout captured at all (e.g. worktree add, whose output is unused)", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isWorktreeAdd, result: { code: 0 } }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.commitSha).toBe("abc123");
  });

  it("throws when git worktree add fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isWorktreeAdd, result: { code: 1, stderr: "fatal: invalid reference" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "bogus" }, { exec, store })).rejects.toThrow(
      /git_worktree_add_failed.*fatal: invalid reference/,
    );
  });

  it("throws when the target-commit date lookup fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isTargetDate, result: { code: 128, stderr: "fatal: bad revision" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "bogus" }, { exec, store })).rejects.toThrow(
      /git_log_target_failed/,
    );
  });

  it("throws when the target-commit date lookup returns empty (commit not found)", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isTargetDate, result: ok("") }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "bogus" }, { exec, store })).rejects.toThrow(
      /git_log_target_failed: no commit found/,
    );
  });

  it("throws when reading commit history fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isHistory, result: { code: 1, stderr: "fatal: history read failed" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_log_history_failed/,
    );
  });

  it("throws when reading reachable tags fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isTag, result: { code: 1, stderr: "fatal: tag read failed" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_tag_merged_failed/,
    );
  });

  it("throws when listing the tree for the README search fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isLsTree, result: { code: 1, stderr: "fatal: ls-tree failed" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_ls_tree_failed/,
    );
  });

  it("throws when a README was found in the tree listing but reading its content fails", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isShow, result: { code: 1, stderr: "fatal: show failed" } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_show_readme_failed/,
    );
  });

  it("rejects a repoFullName that is a string but not owner/repo shaped (too few or too many segments)", async () => {
    const { exec } = scriptedExec(happyPathScripts());
    const store = tempStore();
    const deps = { exec, store };

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "noslash", commitSha: "a" }, deps)).rejects.toThrow("invalid_repo_full_name");
    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "a/b/c", commitSha: "a" }, deps)).rejects.toThrow("invalid_repo_full_name");
  });

  it("assertExecResult falls back to a generic exit-code message when stderr is entirely absent", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isWorktreeAdd, result: { code: 1 } }]));
    const store = tempStore();

    await expect(exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store })).rejects.toThrow(
      /git_worktree_add_failed: exit_1/,
    );
  });

  it("tolerates a commit-history line missing the subject field, defaulting it to an empty string", async () => {
    const { exec } = scriptedExec(happyPathScripts([{ match: isHistory, result: ok(`abc123${FIELD_SEP}2026-01-05T00:00:00+00:00\n`) }]));
    const store = tempStore();

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec, store });

    expect(snapshot.commits).toEqual([{ sha: "abc123", date: "2026-01-05T00:00:00+00:00", subject: "" }]);
  });

  it("fails closed on a malformed input", async () => {
    const { exec } = scriptedExec(happyPathScripts());
    const store = tempStore();
    const deps = { exec, store };

    await expect(exportReplaySnapshot(null as never, deps)).rejects.toThrow("invalid_replay_snapshot_input");
    await expect(exportReplaySnapshot({ commitSha: "a" } as never, deps)).rejects.toThrow("invalid_repo_full_name");
    await expect(exportReplaySnapshot({ repoFullName: "acme/widgets" } as never, deps)).rejects.toThrow("invalid_commit_sha");
    await expect(exportReplaySnapshot({ repoFullName: "acme/widgets", commitSha: "abc123" } as never, deps)).rejects.toThrow("invalid_repo_path");
  });

  it("fails closed when exec is missing or invalid", async () => {
    const store = tempStore();
    const candidate = { repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" };
    await expect(exportReplaySnapshot(candidate, null as never)).rejects.toThrow("invalid_exec");
    await expect(exportReplaySnapshot(candidate, { store } as never)).rejects.toThrow("invalid_exec");
  });

  it("falls back to the default (env-resolved) store when deps.store is omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-replay-snapshot-default-"));
    roots.push(root);
    vi.stubEnv("LOOPOVER_MINER_REPLAY_SNAPSHOT_DB", join(root, "default.sqlite3"));
    const { exec } = scriptedExec(happyPathScripts());

    const snapshot = await exportReplaySnapshot({ repoPath: "/repo", repoFullName: "acme/widgets", commitSha: "abc123" }, { exec });

    expect(snapshot.repoFullName).toBe("acme/widgets");
    vi.unstubAllEnvs();
  });
});

describe("removeReplaySnapshotWorktree (#3010)", () => {
  it("delegates to the shared removeWorktree primitive", async () => {
    const { exec, calls } = scriptedExec([{ match: () => true, result: ok() }]);
    const result = await removeReplaySnapshotWorktree(exec, "/repo", "/repo/.loopover-replay-snapshots/abc123");
    expect(result).toEqual({ ok: true, removed: true });
    expect(calls[0]?.args).toEqual(["worktree", "remove", "--force", "/repo/.loopover-replay-snapshots/abc123"]);
  });
});

describe("openReplaySnapshotStore (#3010) — round-trip persistence", () => {
  it("round-trips a full snapshot including a populated README", () => {
    const store = tempStore();
    const saved = store.saveSnapshot({
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      worktreePath: "/repo/.loopover-replay-snapshots/abc123",
      targetDate: "2026-01-05T00:00:00+00:00",
      commits: [{ sha: "abc123", date: "2026-01-05T00:00:00+00:00", subject: "t" }],
      tags: [{ name: "v1", date: "2026-01-01T00:00:00+00:00", targetSha: "abc000" }],
      readme: { filename: "README.md", content: "# hi\n" },
    });

    expect(saved.readme).toEqual({ filename: "README.md", content: "# hi\n" });
    expect(store.getSnapshot("acme/widgets", "abc123")).toEqual(saved);
  });

  it("round-trips a snapshot with no README as null, not a partial object", () => {
    const store = tempStore();
    const saved = store.saveSnapshot({
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      worktreePath: "/repo/.loopover-replay-snapshots/abc123",
      targetDate: "2026-01-05T00:00:00+00:00",
      commits: [],
      tags: [],
      readme: null,
    });

    expect(saved.readme).toBeNull();
  });

  it("getSnapshot returns null for an unknown (repo, commit) pair", () => {
    const store = tempStore();
    expect(store.getSnapshot("acme/widgets", "nope")).toBeNull();
  });
});
