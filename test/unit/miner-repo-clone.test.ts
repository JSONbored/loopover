import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRepoCloned, resolveRepoCloneBaseDir, resolveRepoCloneDir } from "../../packages/gittensory-miner/lib/repo-clone.js";

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
    expect(resolveRepoCloneBaseDir({ GITTENSORY_MINER_REPO_CLONE_DIR: "/custom/repos" })).toBe("/custom/repos");
    expect(resolveRepoCloneBaseDir({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/repos");
    expect(resolveRepoCloneDir("acme/widgets", { GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/repos/acme/widgets");
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
    const root = tempRoot("gittensory-miner-repo-clone-");
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
  });

  it("respects a non-default baseBranch on the fetch+reset path", async () => {
    const root = tempRoot("gittensory-miner-repo-clone-branch-");
    const originPath = initOriginRepo(root);
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: originPath, stdio: "ignore" });
    const cloneBaseDir = join(root, "cache");

    const first = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, baseBranch: "develop" });
    expect(first.ok).toBe(true);

    commitFile(originPath, "develop-only.txt", "develop content\n");
    const second = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, baseBranch: "develop" });
    expect(second.ok).toBe(true);
    expect(readFileSync(join(second.repoPath, "develop-only.txt"), "utf8")).toBe("develop content\n");
  });

  it("rejects a malformed repoFullName", async () => {
    await expect(ensureRepoCloned("not-a-repo")).rejects.toThrow("invalid_repo_full_name");
  });

  it("returns ok:false with the real git stderr when the clone URL doesn't resolve", async () => {
    const root = tempRoot("gittensory-miner-repo-clone-fail-");
    const cloneBaseDir = join(root, "cache");
    const result = await ensureRepoCloned("acme/does-not-exist", { cloneBaseDir, remoteUrl: join(root, "nonexistent-origin"), timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns ok:false on a fetch failure without touching the existing clone (injected runGit)", async () => {
    const root = tempRoot("gittensory-miner-repo-clone-fetchfail-");
    const originPath = initOriginRepo(root);
    const cloneBaseDir = join(root, "cache");
    const first = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath });
    expect(first.ok).toBe(true);

    const runGit = async (args: string[]) => (args[0] === "fetch" ? { ok: false, stdout: "", stderr: "network unreachable" } : { ok: true, stdout: "", stderr: "" });
    const second = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: originPath, runGit });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("network unreachable");
  });

  it("returns ok:false on a checkout failure and a reset failure (injected runGit)", async () => {
    const root = tempRoot("gittensory-miner-repo-clone-checkoutfail-");
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
  });

  it("returns ok:false with a fallback error message on a clone failure with no stderr (injected runGit)", async () => {
    const root = tempRoot("gittensory-miner-repo-clone-nostderr-");
    const cloneBaseDir = join(root, "cache");
    const runGit = async () => ({ ok: false, stdout: "", stderr: "" });
    const result = await ensureRepoCloned("acme/widgets", { cloneBaseDir, remoteUrl: "unused", runGit });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("git_clone_failed");
  });
});
