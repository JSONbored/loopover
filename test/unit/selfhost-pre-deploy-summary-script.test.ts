import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// See selfhost-update-script.test.ts's own comment on this same timeout raise -- this file does the
// identical real git/bash subprocess sandbox dance.
vi.setConfig({ testTimeout: 60_000 });

// Real end-to-end execution of scripts/selfhost-pre-deploy-summary.sh (#5735) against a throwaway
// git remote, exercising the actual fetch/diff/sensitive-path-flag control flow rather than only
// asserting on the script's source text.

const REAL_SCRIPT = readFileSync("scripts/selfhost-pre-deploy-summary.sh", "utf8");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(args: string[], cwd: string) {
  // -c commit.gpgsign=false: see selfhost-update-script.test.ts's own comment -- disposable sandbox
  // commits must never wait on a contributor's personal signing setup.
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

const sandboxDirs: string[] = [];

afterEach(() => {
  while (sandboxDirs.length > 0) {
    const dir = sandboxDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createSandbox() {
  const base = mkdtempSync(join(tmpdir(), "loopover-selfhost-pre-deploy-summary-"));
  sandboxDirs.push(base);

  const originDir = join(base, "origin.git");
  const seedDir = join(base, "seed");
  const checkoutDir = join(base, "checkout");

  git(["init", "-q", "--bare", originDir], base);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], originDir);

  mkdirSync(seedDir, { recursive: true });
  writeFileSync(join(seedDir, "README.md"), "seed\n");
  mkdirSync(join(seedDir, "scripts"), { recursive: true });
  writeFileSync(join(seedDir, "scripts", "selfhost-pre-deploy-summary.sh"), REAL_SCRIPT);
  git(["init", "-q", "-b", "main", seedDir], base);
  git(["remote", "add", "origin", originDir], seedDir);
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "initial"], seedDir);
  git(["push", "-q", "origin", "main"], seedDir);

  git(["clone", "-q", originDir, checkoutDir], base);

  return { base, originDir, seedDir, checkoutDir };
}

function commitFile(dir: string, relPath: string, contents: string, message: string) {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
}

function run(checkoutDir: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(checkoutDir, "scripts", "selfhost-pre-deploy-summary.sh")], {
    cwd: checkoutDir,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}

describe("selfhost-pre-deploy-summary.sh", () => {
  it("reports up to date and exits 0 when there is nothing new to deploy", () => {
    const { checkoutDir } = createSandbox();

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("up to date");
    expect(result.stdout).toContain("nothing to deploy");
  });

  it("summarizes incoming commits and file changes with no sensitive-path flag when none are touched", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "src/foo.ts", "export const foo = 1;\n", "add foo");
    commitFile(seedDir, "src/bar.ts", "export const bar = 2;\n", "add bar");
    git(["push", "-q", "origin", "main"], seedDir);

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("2 commit(s)");
    expect(result.stdout).toContain("add foo");
    expect(result.stdout).toContain("add bar");
    expect(result.stdout).toContain("src/foo.ts");
    expect(result.stdout).toContain("src/bar.ts");
    expect(result.stdout).toContain("no historically-sensitive paths touched");
  });

  it("flags a docker-compose.yml change as a historically-sensitive path", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "docker-compose.yml", "services:\n  loopover:\n    image: x\n", "bump image");
    git(["push", "-q", "origin", "main"], seedDir);

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 historically-sensitive path(s) touched");
    expect(result.stdout).toContain("docker-compose.yml");
  });

  it("flags grafana provisioning and migrations paths, and only the sensitive ones out of a mixed change", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "grafana/provisioning/dashboards/provider.yml", "disableDeletion: true\n", "grafana change");
    commitFile(seedDir, "migrations/0100_add_column.sql", "alter table x add column y text;\n", "migration");
    commitFile(seedDir, "src/harmless.ts", "export const ok = true;\n", "harmless change");
    git(["push", "-q", "origin", "main"], seedDir);

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("2 historically-sensitive path(s) touched");
    expect(result.stdout).toContain("grafana/provisioning/dashboards/provider.yml");
    expect(result.stdout).toContain("migrations/0100_add_column.sql");
    expect(result.stdout).not.toMatch(/- src\/harmless\.ts/);
  });

  it("flags the deploy scripts themselves as sensitive", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "scripts/selfhost-update.sh", "#!/usr/bin/env bash\necho changed\n", "tweak deploy script");
    git(["push", "-q", "origin", "main"], seedDir);

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("scripts/selfhost-update.sh");
  });

  it("is read-only and safe to run against a dirty working tree", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "src/foo.ts", "export const foo = 1;\n", "add foo");
    git(["push", "-q", "origin", "main"], seedDir);
    writeFileSync(join(checkoutDir, "README.md"), "local uncommitted edit\n");

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 commit(s)");
  });

  it("refuses when the checkout is not on the expected branch", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "src/foo.ts", "export const foo = 1;\n", "add foo");
    git(["push", "-q", "origin", "main"], seedDir);
    git(["checkout", "-q", "-b", "feature-x"], checkoutDir);

    const result = run(checkoutDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("currently on 'feature-x', expected 'main'");
  });

  it("refuses a detached HEAD with a distinct message instead of the generic branch mismatch", () => {
    const { checkoutDir } = createSandbox();
    git(["checkout", "-q", "--detach", "HEAD"], checkoutDir);

    const result = run(checkoutDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("detached HEAD state");
  });

  it("gives a distinct error when SELFHOST_UPDATE_BRANCH names a branch the remote doesn't have", () => {
    const { checkoutDir } = createSandbox();
    git(["checkout", "-q", "-b", "no-such-branch-upstream"], checkoutDir);

    const result = run(checkoutDir, { SELFHOST_UPDATE_BRANCH: "no-such-branch-upstream" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("origin/no-such-branch-upstream does not exist");
  });

  it("accepts a non-default branch when SELFHOST_UPDATE_BRANCH names it explicitly", () => {
    const { seedDir, checkoutDir } = createSandbox();
    git(["checkout", "-q", "-b", "release"], seedDir);
    git(["push", "-q", "origin", "release"], seedDir);
    git(["fetch", "-q", "origin"], checkoutDir);
    git(["checkout", "-q", "-b", "release", "origin/release"], checkoutDir);
    commitFile(seedDir, "src/foo.ts", "export const foo = 1;\n", "release commit");
    git(["push", "-q", "origin", "release"], seedDir);

    const result = run(checkoutDir, { SELFHOST_UPDATE_BRANCH: "release" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 commit(s)");
  });

  it("warns and falls back to a merge-base range when local history has diverged from the remote", () => {
    const { seedDir, checkoutDir } = createSandbox();
    commitFile(seedDir, "src/upstream-only.ts", "export const up = 1;\n", "upstream commit");
    git(["push", "-q", "origin", "main"], seedDir);
    commitFile(checkoutDir, "src/local-only.ts", "export const local = 1;\n", "local-only commit");

    const result = run(checkoutDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("is not an ancestor");
    expect(result.stdout).toContain("upstream commit");
  });

  it("surfaces an error instead of a false all-clear when git diff --name-only fails (#7775)", () => {
    const { base, seedDir, checkoutDir } = createSandbox();
    // Give origin an incoming commit so the script proceeds past "up to date" to the sensitive-path diff.
    commitFile(seedDir, "src/incoming.ts", "export const incoming = 1;\n", "incoming commit");
    git(["push", "-q", "origin", "main"], seedDir);

    // Shadow `git` with a fake that fails ONLY `git diff --name-only ...` (the sensitive-path scan),
    // delegating every other command -- including fetch and the `git diff --stat` summary -- to real git.
    const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = join(base, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "git"),
      `#!/usr/bin/env bash\nif [ "$1" = "diff" ] && [ "$2" = "--name-only" ]; then\n  echo "forced diff failure" >&2\n  exit 1\nfi\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );

    const result = run(checkoutDir, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });

    // A failed diff must be reported as a failure, not silently presented as "no sensitive paths touched".
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/git diff.*failed|cannot assess historically-sensitive/i);
    expect(result.stdout).not.toContain("no historically-sensitive paths touched");
  });
});
