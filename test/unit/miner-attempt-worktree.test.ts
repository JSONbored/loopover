import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { cleanupAttemptWorktree, createRealWorktreeExec, prepareAttemptWorktree } from "../../packages/gittensory-miner/lib/attempt-worktree.js";

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

function initOriginRepo(root: string) {
  const originPath = join(root, "origin");
  execFileSync("git", ["init", "--initial-branch=main", originPath], { stdio: "ignore" });
  writeFileSync(join(originPath, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: originPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: originPath, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
  return originPath;
}

describe("createRealWorktreeExec (#5132)", () => {
  it("captures stdout and a zero exit code from a real short-lived command", async () => {
    const exec = createRealWorktreeExec();
    const result = await exec(process.execPath, ["-e", "process.stdout.write('hello')"], { cwd: process.cwd() });
    expect(result).toEqual({ code: 0, stdout: "hello", stderr: "" });
  });

  it("resolves (never rejects) with code:null and the error message when the command doesn't exist", async () => {
    const exec = createRealWorktreeExec();
    const result = await exec("this-command-definitely-does-not-exist-xyz", [], { cwd: process.cwd() });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("this-command-definitely-does-not-exist-xyz");
  });

  it("kills a long-lived process and resolves with a timeout marker when it elapses", async () => {
    const exec = createRealWorktreeExec(100);
    const result = await exec(process.execPath, ["-e", "setInterval(() => {}, 50)"], { cwd: process.cwd() });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("timed_out_after_100ms");
  });
});

describe("prepareAttemptWorktree / cleanupAttemptWorktree (#5132)", () => {
  it("REGRESSION: worktreePath is a real, checked-out git repo on a real branch, not an empty directory", async () => {
    const root = tempRoot("gittensory-miner-attempt-worktree-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");

    const result = await prepareAttemptWorktree("acme/widgets", "attempt-1", { cloneBaseDir, remoteUrl: originPath });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.branchName).toBe("gittensory/attempt/attempt-1");
    expect(existsSync(result.worktreePath)).toBe(true);
    // The critical assertion: real repo content is actually present, not an empty directory.
    expect(readFileSync(join(result.worktreePath, "README.md"), "utf8")).toBe("hello\n");
    // And it's a real, distinct branch -- not just a copy of main.
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: result.worktreePath, encoding: "utf8" }).trim();
    expect(branch).toBe("gittensory/attempt/attempt-1");
  });

  it("removes a succeeded attempt's worktree but retains a failed one's, per the engine's own retention policy", async () => {
    const root = tempRoot("gittensory-miner-attempt-worktree-cleanup-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");

    const succeeded = await prepareAttemptWorktree("acme/widgets", "attempt-ok", { cloneBaseDir, remoteUrl: originPath });
    if (!succeeded.ok) throw new Error("expected ok");
    const removedResult = await cleanupAttemptWorktree(succeeded.repoPath, succeeded.worktreePath, true);
    expect(removedResult).toEqual({ ok: true, removed: true });
    expect(existsSync(succeeded.worktreePath)).toBe(false);

    const failed = await prepareAttemptWorktree("acme/widgets", "attempt-fail", { cloneBaseDir, remoteUrl: originPath });
    if (!failed.ok) throw new Error("expected ok");
    const retainedResult = await cleanupAttemptWorktree(failed.repoPath, failed.worktreePath, false);
    expect(retainedResult).toEqual({ ok: true, removed: false });
    expect(existsSync(failed.worktreePath)).toBe(true);
  });

  it("returns ok:false when the base clone cannot be prepared, without attempting git worktree add", async () => {
    const root = tempRoot("gittensory-miner-attempt-worktree-clonefail-");
    const cloneBaseDir = join(root, "cache");
    const execSpy = vi.fn();

    const result = await prepareAttemptWorktree("acme/does-not-exist", "attempt-1", {
      cloneBaseDir,
      remoteUrl: join(root, "nonexistent-origin"),
      exec: execSpy,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeTruthy();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false with git's real stderr when git worktree add fails (e.g. an unknown base branch)", async () => {
    const root = tempRoot("gittensory-miner-attempt-worktree-addfail-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");

    const result = await prepareAttemptWorktree("acme/widgets", "attempt-1", { cloneBaseDir, remoteUrl: originPath, baseBranch: "does-not-exist" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.repoPath).toBe(join(cloneBaseDir, "acme", "widgets"));
    expect(result.error).toBeTruthy();
  });
});
