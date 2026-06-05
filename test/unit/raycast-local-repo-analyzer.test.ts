import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchAnalysisPayload,
  collectRaycastLocalRepoMetadata,
  parseGitHubRemote,
  runRaycastBranchAnalysisCommand,
  type RaycastBranchAnalysisFetch,
  type RaycastGitRunner,
} from "../../src/raycast/local-repo-analyzer";

const TOKEN = `gts_${"c".repeat(64)}`;
let tempDir: string | null = null;

describe("Raycast local repo analyzer", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("parses GitHub remotes without keeping local paths", () => {
    expect(parseGitHubRemote("git@github.com:JSONbored/gittensory.git")).toBe("JSONbored/gittensory");
    expect(parseGitHubRemote("https://github.com/JSONbored/gittensory.git")).toBe("JSONbored/gittensory");
    expect(parseGitHubRemote("ssh://git@github.com/JSONbored/gittensory.git")).toBe("JSONbored/gittensory");
    expect(parseGitHubRemote("/tmp/local/repo")).toBeUndefined();
    expect(parseGitHubRemote(undefined as unknown as string)).toBeUndefined();
  });

  it("requires an explicit repo name when the GitHub remote cannot be inferred", () => {
    expect(() =>
      collectRaycastLocalRepoMetadata({
        cwd: "/tmp/private-checkout",
        login: "jsonbored",
        git: fakeGit({
          "config --get remote.origin.url": "file:///tmp/private-checkout\n",
        }).git,
      }),
    ).toThrow(/repoFullName/i);
  });

  it("collects metadata-only git state with renamed, binary, deleted, stale-base, tests, hints, and linked issues", () => {
    const { git, calls } = fakeGit({
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
      "config --get remote.origin.url": "git@github.com:JSONbored/gittensory.git\n",
      "branch --show-current": "feat/raycast-116\n",
      "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
      "rev-parse --verify main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
      "merge-base main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "rev-parse --verify origin/main": "cccccccccccccccccccccccccccccccccccccccc\n",
      "diff --name-status -M main --": [
        "M\tsrc/raycast/local-repo-analyzer.ts",
        "R100\tsrc/old-name.ts\tsrc/new-name.ts",
        "D\tsrc/delete-me.ts",
        "M\tassets/logo.png",
        "M\ttest/unit/raycast-local-repo-analyzer.test.ts",
        "M\tpackage.json",
      ].join("\n"),
      "diff --numstat -M main --": [
        "14\t2\tsrc/raycast/local-repo-analyzer.ts",
        "3\t1\tsrc/new-name.ts",
        "0\t9\tsrc/delete-me.ts",
        "-\t-\tassets/logo.png",
        "28\t0\ttest/unit/raycast-local-repo-analyzer.test.ts",
        "1\t0\tpackage.json",
      ].join("\n"),
      "log --format=%s%n%b main..HEAD": "feat: add Raycast analyzer\n\nCloses #116\n",
    });

    const metadata = collectRaycastLocalRepoMetadata({
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      body: "Follow-up for #116",
      git,
    });

    expect(metadata).toMatchObject({
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      headRef: "feat/raycast-116",
      branchName: "feat/raycast-116",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remoteTrackingSha: "cccccccccccccccccccccccccccccccccccccccc",
      linkedIssues: [116],
      testFileCount: 1,
      sourceUpload: { enabled: false, mode: "metadata_only" },
    });
    expect(metadata.changedFiles).toEqual([
      { path: "src/raycast/local-repo-analyzer.ts", additions: 14, deletions: 2, status: "modified", binary: false },
      { path: "src/new-name.ts", previousPath: "src/old-name.ts", additions: 3, deletions: 1, status: "renamed", binary: false },
      { path: "src/delete-me.ts", additions: 0, deletions: 9, status: "deleted", binary: false },
      { path: "assets/logo.png", additions: 0, deletions: 0, status: "modified", binary: true },
      { path: "test/unit/raycast-local-repo-analyzer.test.ts", additions: 28, deletions: 0, status: "modified", binary: false },
      { path: "package.json", additions: 1, deletions: 0, status: "modified", binary: false },
    ]);
    expect(metadata.warnings.join("\n")).toMatch(/stale.*cccccccccccc/i);
    expect(metadata.validationHints).toEqual(
      expect.arrayContaining([
        "1 changed test file(s) detected.",
        "Build or dependency manifests changed; rerun the repository's standard validation gate.",
        "Binary file metadata detected; review binary diffs locally before relying on metadata-only analysis.",
      ]),
    );
    expect(JSON.stringify(metadata)).not.toMatch(/private-checkout|sourceContents|content|diffText|wallet|hotkey/i);
    expect(calls.map((call) => call.split(" ")[0]).join("\n")).not.toMatch(/^(cat|show|grep|archive)$/m);
  });

  it("rejects source upload mode before running git", () => {
    const git = vi.fn<RaycastGitRunner>();

    expect(() =>
      collectRaycastLocalRepoMetadata({
        cwd: "/tmp/private-checkout",
        login: "jsonbored",
        repoFullName: "JSONbored/gittensory",
        sourceUploadMode: "source_upload",
        git,
      }),
    ).toThrow(/metadata-only/i);
    expect(git).not.toHaveBeenCalled();
  });

  it("accepts explicit metadata-only mode and handles copied, unknown, and brace-style renamed paths", () => {
    const metadata = collectRaycastLocalRepoMetadata({
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "origin/main",
      sourceUploadMode: "metadata_only",
      linkedIssues: [116, 116],
      validationHints: ["Run npm run test:ci before publishing."],
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "rev-parse --verify origin/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "merge-base origin/main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "diff --name-status -M origin/main --": [
          "C100\tsrc/source.ts\tsrc/copied.ts",
          "R100\tsrc/old-name.ts\tsrc/new-name.ts",
          "T\tweird-mode.file",
        ].join("\n"),
        "diff --numstat -M origin/main --": [
          "4\t0\tsrc/copied.ts",
          "2\t1\tsrc/{old-name.ts => new-name.ts}",
          "0\t0\tweird-mode.file",
        ].join("\n"),
        "log --format=%s%n%b origin/main..HEAD": "docs: branch analysis\n",
      }).git,
    });

    expect(metadata.changedFiles).toEqual([
      { path: "src/copied.ts", previousPath: "src/source.ts", additions: 4, deletions: 0, status: "copied", binary: false },
      { path: "src/new-name.ts", previousPath: "src/old-name.ts", additions: 2, deletions: 1, status: "renamed", binary: false },
      { path: "weird-mode.file", additions: 0, deletions: 0, status: "unknown", binary: false },
    ]);
    expect(metadata.linkedIssues).toEqual([116]);
    expect(metadata.validationHints).toEqual(expect.arrayContaining(["Run npm run test:ci before publishing."]));
  });

  it("uses safe defaults and workflow hints when optional git metadata is absent", () => {
    const metadata = collectRaycastLocalRepoMetadata({
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      git: fakeGit({
        "config --get remote.origin.url": "https://github.com/JSONbored/gittensory.git\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "diff --name-status -M main --": "M\t.github/workflows/ci.yml\nT\nR100\tsrc/old-only.ts",
        "diff --numstat -M main --": "NaN\tNaN\t.github/workflows/ci.yml\n",
        "log --format=%s%n%b main..HEAD": "feat: workflow tune\nRefs #9 and closes #7\n",
      }).git,
    });

    expect(metadata).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      branchName: "local-branch",
      headRef: "local-branch",
      linkedIssues: [7, 9],
    });
    expect(metadata.changedFiles).toEqual([
      { path: ".github/workflows/ci.yml", additions: 0, deletions: 0, status: "modified", binary: false },
      { path: "", additions: 0, deletions: 0, status: "unknown", binary: false },
      { path: "src/old-only.ts", previousPath: "src/old-only.ts", additions: 0, deletions: 0, status: "renamed", binary: false },
    ]);
    expect(metadata.validationHints).toEqual(expect.arrayContaining(["Workflow files changed; required-check behavior may change."]));
  });

  it("collects metadata from a real local git checkout without reading file contents", () => {
    tempDir = mkdtempSync(join(tmpdir(), "raycast-local-git-"));
    mkdirSync(join(tempDir, "src"), { recursive: true });
    git(tempDir, ["init", "-b", "main"]);
    git(tempDir, ["config", "user.email", "test@example.com"]);
    git(tempDir, ["config", "user.name", "Test User"]);
    git(tempDir, ["remote", "add", "origin", "https://github.com/JSONbored/gittensory.git"]);
    writeFileSync(join(tempDir, "README.md"), "initial\n");
    git(tempDir, ["add", "README.md"]);
    git(tempDir, ["commit", "-m", "initial"]);
    git(tempDir, ["checkout", "-b", "feat/raycast-116"]);
    writeFileSync(join(tempDir, "src/index.ts"), "export const value = 116;\n");
    git(tempDir, ["add", "src/index.ts"]);

    const metadata = collectRaycastLocalRepoMetadata({
      cwd: tempDir,
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
    });

    expect(metadata.branchName).toBe("feat/raycast-116");
    expect(metadata.changedFiles).toEqual([
      { path: "src/index.ts", additions: 1, deletions: 0, status: "added", binary: false },
    ]);
    expect(JSON.stringify(metadata)).not.toContain(tempDir);
    expect(JSON.stringify(metadata)).not.toContain("export const value");
  });

  it("falls back to empty git metadata when git commands cannot run", () => {
    const metadata = collectRaycastLocalRepoMetadata({
      cwd: "/tmp/definitely-missing-gittensory-raycast-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      branchName: "manual-branch",
    });

    expect(metadata).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      branchName: "manual-branch",
      headRef: "manual-branch",
      changedFiles: [],
      validationHints: ["No changed test files detected; include focused validation before requesting review."],
      sourceUpload: { enabled: false, mode: "metadata_only" },
    });
  });

  it("builds a branch-analysis API payload that excludes source upload fields", () => {
    const metadata = collectRaycastLocalRepoMetadata({
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "origin/main",
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "rev-parse --verify origin/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "merge-base origin/main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "diff --name-status -M origin/main --": "M\tsrc/index.ts\n",
        "diff --numstat -M origin/main --": "7\t1\tsrc/index.ts\n",
        "log --format=%s%n%b origin/main..HEAD": "fix: small branch\n",
      }).git,
    });

    const payload = branchAnalysisPayload(metadata);

    expect(payload).toMatchObject({
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "origin/main",
      localScorer: { mode: "metadata_only" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/sourceUpload|sourceContents|content|diffText|private-checkout/i);
  });

  it("posts metadata to the existing local branch-analysis API", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: "ready", summary: "analysis complete" });
    const result = await runRaycastBranchAnalysisCommand({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      fetchImpl,
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "rev-parse --verify main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "merge-base main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify origin/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "diff --name-status -M main --": "M\tsrc/index.ts\n",
        "diff --numstat -M main --": "7\t1\tsrc/index.ts\n",
        "log --format=%s%n%b main..HEAD": "fix: small branch\n",
      }).git,
    });

    expect(result.status).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/local/branch-analysis" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toMatchObject({
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      changedFiles: [{ path: "src/index.ts", additions: 7, deletions: 1, status: "modified", binary: false }],
      localScorer: { mode: "metadata_only" },
    });
  });

  it("degrades cleanly when the branch-analysis API returns an error", async () => {
    const { fetchImpl } = fakeFetch({ error: "api_down" }, 503);
    const result = await runRaycastBranchAnalysisCommand({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      fetchImpl,
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "rev-parse --verify main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "merge-base main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify origin/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "diff --name-status -M main --": "M\tsrc/index.ts\n",
        "diff --numstat -M main --": "7\t1\tsrc/index.ts\n",
        "log --format=%s%n%b main..HEAD": "fix: small branch\n",
      }).git,
    });

    expect(result).toMatchObject({
      status: "api_error",
      error: "api_down",
      rerunGuidance: expect.stringContaining("metadata payload was not expanded with source contents"),
      metadata: { sourceUpload: { enabled: false, mode: "metadata_only" } },
    });
  });

  it("uses response status text when API errors are not structured", async () => {
    const { fetchImpl } = fakeFetch("temporary outage", 502);
    const result = await runRaycastBranchAnalysisCommand({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      fetchImpl,
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "rev-parse --verify main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        "merge-base main HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "rev-parse --verify origin/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "diff --name-status -M main --": "",
        "diff --numstat -M main --": "",
        "log --format=%s%n%b main..HEAD": "",
      }).git,
    });

    expect(result).toMatchObject({
      status: "api_error",
      error: "502 Service unavailable",
    });
  });

  it("keeps API degradation structured for thrown and status-only failures", async () => {
    const thrown = await runRaycastBranchAnalysisCommand({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      fetchImpl: vi.fn(async () => {
        throw "network_down";
      }),
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "diff --name-status -M main --": "",
        "diff --numstat -M main --": "",
        "log --format=%s%n%b main..HEAD": "",
      }).git,
    });
    expect(thrown).toMatchObject({ status: "api_error", error: "network_down" });

    const statusOnly = await runRaycastBranchAnalysisCommand({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      cwd: "/tmp/private-checkout",
      login: "jsonbored",
      repoFullName: "JSONbored/gittensory",
      baseRef: "main",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 504,
        async json() {
          return "timeout";
        },
      })),
      git: fakeGit({
        "branch --show-current": "feat/raycast-116\n",
        "rev-parse --abbrev-ref HEAD": "feat/raycast-116\n",
        "diff --name-status -M main --": "",
        "diff --numstat -M main --": "",
        "log --format=%s%n%b main..HEAD": "",
      }).git,
    });
    expect(statusOnly).toMatchObject({
      status: "api_error",
      error: "504 Raycast branch analysis request failed",
    });
  });
});

function fakeGit(responses: Record<string, string>): { git: RaycastGitRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    git: (_cwd, args) => {
      const key = args.join(" ");
      calls.push(key);
      return (responses[key] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
  };
}

function fakeFetch(payload: unknown, status = 200): {
  fetchImpl: RaycastBranchAnalysisFetch;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  return {
    calls,
    fetchImpl: vi.fn(async (input, init) => {
      const url = new URL(input);
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Service unavailable",
        async json() {
          return payload;
        },
      };
    }),
  };
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}
