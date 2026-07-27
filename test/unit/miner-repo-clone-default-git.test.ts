import { afterEach, describe, expect, it, vi } from "vitest";

// Cover defaultRunGit's catch arms (stderr string vs Error.message vs String(non-Error)) without
// touching the real-git paths in miner-repo-clone.test.ts. Mock execFile before importing the module
// under test so the promisified helper binds to the spy.

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
});

async function loadEnsureRepoCloned() {
  const mod = await import("../../packages/loopover-miner/lib/repo-clone");
  return mod.ensureRepoCloned;
}

describe("repo-clone defaultRunGit error shaping (#7314 coverage)", () => {
  it("prefers Error.stderr when git fails with a string stderr", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error("clone failed"), { stderr: "fatal: repository not found" });
      (cb as (error: Error) => void)(err);
    });
    const ensureRepoCloned = await loadEnsureRepoCloned();
    const result = await ensureRepoCloned("acme/widgets", {
      cloneBaseDir: "/tmp/loopover-miner-repo-clone-mock-stderr",
      remoteUrl: "https://example.invalid/acme/widgets.git",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fatal: repository not found");
  });

  it("falls back to Error.message when stderr is absent", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: Error) => void)(new Error("spawn git ENOENT"));
    });
    const ensureRepoCloned = await loadEnsureRepoCloned();
    const result = await ensureRepoCloned("acme/widgets", {
      cloneBaseDir: "/tmp/loopover-miner-repo-clone-mock-message",
      remoteUrl: "https://example.invalid/acme/widgets.git",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn git ENOENT");
  });

  it("stringifies a non-Error rejection when stderr is absent", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: unknown) => void)("raw-git-failure");
    });
    const ensureRepoCloned = await loadEnsureRepoCloned();
    const result = await ensureRepoCloned("acme/widgets", {
      cloneBaseDir: "/tmp/loopover-miner-repo-clone-mock-raw",
      remoteUrl: "https://example.invalid/acme/widgets.git",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("raw-git-failure");
  });
});
