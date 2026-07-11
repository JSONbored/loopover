import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// Real end-to-end execution of scripts/selfhost-update.sh (#1660) against a throwaway git remote,
// with deploy-selfhost-prebuilt.sh and selfhost-post-update-check.sh replaced by stubs that just
// log a call marker -- this exercises the actual fetch/fast-forward/rebuild/verify control flow
// (and its refusal paths) rather than only asserting on the script's source text.

const REAL_SCRIPT = readFileSync(resolve("scripts/selfhost-update.sh"), "utf8");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const STUB_PREBUILT = `#!/usr/bin/env bash
set -euo pipefail
printf 'prebuilt-called\\n' >> "$CALL_LOG"
exit "\${STUB_PREBUILT_EXIT:-0}"
`;

const STUB_POST_UPDATE = `#!/usr/bin/env bash
set -euo pipefail
printf 'post-update-called\\n' >> "$CALL_LOG"
exit "\${STUB_POST_UPDATE_EXIT:-0}"
`;

function git(args: string[], cwd: string) {
  // -c commit.gpgsign=false: these are disposable sandbox repos for exercising the script's git
  // plumbing, not real commits -- they must never depend on (or block on) a contributor's personal
  // signing setup. Without this, a machine with `commit.gpgsign=true` and a hardware-backed signing
  // key (e.g. a TouchID-gated SSH key) makes every sandbox commit wait on an interactive prompt that
  // never comes in a test run, which manifests as a flaky ~15s test timeout on an arbitrary test.
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result;
}

function headOf(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd).stdout.trim();
}

const sandboxDirs: string[] = [];

afterEach(() => {
  while (sandboxDirs.length > 0) {
    const dir = sandboxDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createSandbox() {
  const base = mkdtempSync(join(tmpdir(), "gittensory-selfhost-update-"));
  sandboxDirs.push(base);

  const originDir = join(base, "origin.git");
  const seedDir = join(base, "seed");
  const checkoutDir = join(base, "checkout");
  const callLog = join(base, "calls.log");

  // A bare "upstream" the seed repo pushes to and the checkout clones from. Forcing HEAD's symref
  // to refs/heads/main before the first push means every later `git clone` of this bare repo
  // checks out `main` directly -- no fallback branch-detection dance needed in the test itself.
  git(["init", "-q", "--bare", originDir], base);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], originDir);

  // The real script plus its two stubbed collaborators are committed in the SEED repo, before
  // checkoutDir ever clones -- committing them into checkoutDir instead (after cloning) would
  // advance checkoutDir's history one commit past origin/main, and every later advanceOrigin()
  // push from seedDir would then be rejected as a non-fast-forward against its own history.
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(join(seedDir, "README.md"), "seed\n");
  mkdirSync(join(seedDir, "scripts"), { recursive: true });
  writeFileSync(join(seedDir, "scripts", "selfhost-update.sh"), REAL_SCRIPT);
  chmodSync(join(seedDir, "scripts", "selfhost-update.sh"), 0o755);
  writeFileSync(join(seedDir, "scripts", "deploy-selfhost-prebuilt.sh"), STUB_PREBUILT);
  chmodSync(join(seedDir, "scripts", "deploy-selfhost-prebuilt.sh"), 0o755);
  writeFileSync(join(seedDir, "scripts", "selfhost-post-update-check.sh"), STUB_POST_UPDATE);
  chmodSync(join(seedDir, "scripts", "selfhost-post-update-check.sh"), 0o755);
  git(["init", "-q", "-b", "main", seedDir], base);
  git(["remote", "add", "origin", originDir], seedDir);
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "initial"], seedDir);
  git(["push", "-q", "origin", "main"], seedDir);

  git(["clone", "-q", originDir, checkoutDir], base);

  return { base, originDir, seedDir, checkoutDir, callLog };
}

function advanceOrigin(seedDir: string, message: string) {
  writeFileSync(join(seedDir, "README.md"), `${message}\n`, { flag: "a" });
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", message], seedDir);
  git(["push", "-q", "origin", "main"], seedDir);
}

function readCallLog(callLog: string): string {
  try {
    return readFileSync(callLog, "utf8");
  } catch {
    return "";
  }
}

function run(checkoutDir: string, callLog: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(checkoutDir, "scripts", "selfhost-update.sh")], {
    cwd: checkoutDir,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, CALL_LOG: callLog, ...env },
  });
}

describe("selfhost-update.sh", () => {
  it("fetches, fast-forwards, rebuilds, and verifies health on a clean checkout", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance readme");

    const result = run(checkoutDir, callLog);

    expect(result.status, result.stderr).toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\npost-update-called\n");
    expect(result.stdout).toContain("selfhost update: complete");
    expect(headOf(checkoutDir)).toBe(headOf(seedDir));
  });

  it("is a safe no-op restart-equivalent when already up to date", () => {
    const { checkoutDir, callLog } = createSandbox();

    const result = run(checkoutDir, callLog);

    expect(result.status, result.stderr).toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\npost-update-called\n");
  });

  it("skips the health probe when SELFHOST_SKIP_POST_UPDATE_CHECK=1", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for skip-check");

    const result = run(checkoutDir, callLog, { SELFHOST_SKIP_POST_UPDATE_CHECK: "1" });

    expect(result.status, result.stderr).toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\n");
    expect(result.stdout).toContain("skipping post-update health check");
  });

  it("stops before the health check when the rebuild step fails", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for rebuild-fail");

    const result = run(checkoutDir, callLog, { STUB_PREBUILT_EXIT: "1" });

    expect(result.status).not.toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\n");
  });

  it("refuses a dirty working tree and calls no script", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for dirty-tree");
    writeFileSync(join(checkoutDir, "README.md"), "local uncommitted edit\n");
    const beforeHead = headOf(checkoutDir);

    const result = run(checkoutDir, callLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("working tree is not clean");
    expect(readCallLog(callLog)).toBe("");
    expect(headOf(checkoutDir)).toBe(beforeHead);
  });

  it("refuses when the checkout is not on the expected branch and calls no script", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for wrong-branch");
    git(["checkout", "-q", "-b", "feature-x"], checkoutDir);

    const result = run(checkoutDir, callLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("currently on 'feature-x', expected 'main'");
    expect(readCallLog(callLog)).toBe("");
  });

  it("refuses a detached HEAD with a distinct message instead of the generic branch mismatch", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for detached-head");
    git(["checkout", "-q", "--detach", "HEAD"], checkoutDir);

    const result = run(checkoutDir, callLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("detached HEAD state");
    expect(result.stderr).not.toContain("currently on 'HEAD'");
    expect(readCallLog(callLog)).toBe("");
  });

  it("gives a distinct error when SELFHOST_UPDATE_BRANCH names a branch the remote doesn't have", () => {
    const { checkoutDir, callLog } = createSandbox();
    // The local checkout must actually be on the named branch for the branch-mismatch check to
    // pass, so this exercises the *next* guard: the branch exists locally but has no upstream
    // counterpart to fast-forward from.
    git(["checkout", "-q", "-b", "no-such-branch-upstream"], checkoutDir);

    const result = run(checkoutDir, callLog, { SELFHOST_UPDATE_BRANCH: "no-such-branch-upstream" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("origin/no-such-branch-upstream does not exist");
    expect(result.stderr).not.toContain("could not be fast-forwarded");
    expect(readCallLog(callLog)).toBe("");
  });

  it("accepts a non-default branch when SELFHOST_UPDATE_BRANCH names it explicitly", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    git(["checkout", "-q", "-b", "release"], seedDir);
    writeFileSync(join(seedDir, "README.md"), "release branch\n", { flag: "a" });
    git(["add", "-A"], seedDir);
    git(["commit", "-q", "-m", "release commit"], seedDir);
    git(["push", "-q", "origin", "release"], seedDir);
    git(["fetch", "-q", "origin"], checkoutDir);
    git(["checkout", "-q", "-b", "release", "origin/release"], checkoutDir);

    const result = run(checkoutDir, callLog, { SELFHOST_UPDATE_BRANCH: "release" });

    expect(result.status, result.stderr).toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\npost-update-called\n");
  });

  it("refuses a non-fast-forward divergence, calls no script, and leaves HEAD untouched", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    advanceOrigin(seedDir, "advance for divergence");
    writeFileSync(join(checkoutDir, "local-only.txt"), "local\n");
    git(["add", "-A"], checkoutDir);
    git(["commit", "-q", "-m", "local unpushed commit"], checkoutDir);
    const beforeHead = headOf(checkoutDir);

    const result = run(checkoutDir, callLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not be fast-forwarded");
    expect(result.stderr).toContain("never rebases or force-merges");
    expect(readCallLog(callLog)).toBe("");
    expect(headOf(checkoutDir)).toBe(beforeHead);
  });

  it("supports a custom remote name via SELFHOST_UPDATE_REMOTE", () => {
    const { seedDir, checkoutDir, callLog } = createSandbox();
    git(["remote", "rename", "origin", "upstream"], checkoutDir);
    advanceOrigin(seedDir, "advance for custom remote");

    const result = run(checkoutDir, callLog, { SELFHOST_UPDATE_REMOTE: "upstream" });

    expect(result.status, result.stderr).toBe(0);
    expect(readCallLog(callLog)).toBe("prebuilt-called\npost-update-called\n");
    expect(headOf(checkoutDir)).toBe(headOf(seedDir));
  });

  it("fails fast outside a git checkout", () => {
    const outside = mkdtempSync(join(tmpdir(), "gittensory-selfhost-update-nogit-"));
    sandboxDirs.push(outside);
    mkdirSync(join(outside, "scripts"), { recursive: true });
    writeFileSync(join(outside, "scripts", "selfhost-update.sh"), REAL_SCRIPT);
    chmodSync(join(outside, "scripts", "selfhost-update.sh"), 0o755);

    const result = spawnSync("bash", [join(outside, "scripts", "selfhost-update.sh")], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run this script from the gittensory git checkout");
  });
});
