import { afterEach, describe, expect, it, vi } from "vitest";
import { closeResolvedIssueIfPresent, isReleaseWatchIssue } from "../../scripts/check-package-release-due.js";
import { buildPackageReleaseIssue, buildPackageReleaseReport, isPackageReleaseRelevantCommit, PACKAGE_RELEASE_CONFIGS, selectPackageReleaseCommits } from "../../scripts/package-release-core.js";

const engineConfig = PACKAGE_RELEASE_CONFIGS.engine;

type TestCommit = {
  sha: string;
  subject: string;
  files: string[];
};

function commit(subject: string, files: string[], sha = subject): TestCommit {
  return { sha: sha.padEnd(40, "0").slice(0, 40), subject, files };
}

describe("package release commit selection (#8591)", () => {
  it("includes a commit touching the package's own directory", () => {
    const commits = selectPackageReleaseCommits([commit("feat(engine): add new signal (#1)", ["packages/loopover-engine/src/foo.ts"])], engineConfig);
    expect(commits.map((entry) => entry.subject)).toEqual(["feat(engine): add new signal (#1)"]);
  });

  it("excludes a commit that never touches the package's directory", () => {
    const commits = selectPackageReleaseCommits([commit("feat(ui): add dashboard card (#2)", ["apps/loopover-ui/src/routes/app.tsx"])], engineConfig);
    expect(commits).toEqual([]);
  });

  it("excludes merge commits", () => {
    expect(isPackageReleaseRelevantCommit(commit("Merge pull request #3", ["packages/loopover-engine/src/foo.ts"]), engineConfig)).toBe(false);
  });

  it("excludes non-conventional commit subjects", () => {
    expect(isPackageReleaseRelevantCommit(commit("random notes", ["packages/loopover-engine/src/foo.ts"]), engineConfig)).toBe(false);
  });

  it("excludes release/changelog-scoped commits (release-please's own bump commits)", () => {
    expect(isPackageReleaseRelevantCommit(commit("chore(release): cut engine v3.15.0", ["packages/loopover-engine/package.json"]), engineConfig)).toBe(false);
    expect(isPackageReleaseRelevantCommit(commit("chore(changelog): regenerate", ["packages/loopover-engine/CHANGELOG.md"]), engineConfig)).toBe(false);
  });

  it("scopes independently per package (an engine-scoped commit doesn't count for miner)", () => {
    const c = commit("fix(engine): correct rounding (#4)", ["packages/loopover-engine/src/foo.ts"]);
    expect(isPackageReleaseRelevantCommit(c, PACKAGE_RELEASE_CONFIGS.engine)).toBe(true);
    expect(isPackageReleaseRelevantCommit(c, PACKAGE_RELEASE_CONFIGS.miner)).toBe(false);
  });
});

describe("buildPackageReleaseReport / buildPackageReleaseIssue", () => {
  it("builds a release-due issue with the version and checklist", () => {
    const report = buildPackageReleaseReport({
      config: engineConfig,
      latestTag: { tag: "engine-v3.14.0", version: "3.14.0" },
      packageVersion: "3.14.0",
      publishedVersion: "3.14.0",
      commits: [commit("feat(engine): add new signal (#1)", ["packages/loopover-engine/src/foo.ts"])],
    });
    const issue = buildPackageReleaseIssue(report, engineConfig);

    expect(report).toMatchObject({ due: true, proposedVersion: "3.15.0", releaseType: "minor" });
    expect(issue.title).toBe("Engine release due: 3.15.0");
    expect(issue.body).toContain("<!-- loopover:engine-release-due -->");
    expect(issue.body).toContain("- [ ] Run `npm run test:engine-pack`");
    expect(issue.body).toContain("- [ ] Tag `engine-v3.15.0`");
    expect(issue.body).toContain("Merge the release-please PR");
  });

  it("is due when npm hasn't caught up to the package.json version, even with zero relevant commits", () => {
    const report = buildPackageReleaseReport({
      config: engineConfig,
      latestTag: { tag: "engine-v3.14.0", version: "3.14.0" },
      packageVersion: "3.14.0",
      publishedVersion: "3.13.0",
      commits: [],
    });
    expect(report).toMatchObject({ due: true, proposedVersion: "3.14.0", releaseType: null });
  });

  it("is not due when tag, package version, and npm all agree with zero relevant commits", () => {
    const report = buildPackageReleaseReport({
      config: engineConfig,
      latestTag: { tag: "engine-v3.14.0", version: "3.14.0" },
      packageVersion: "3.14.0",
      publishedVersion: "3.14.0",
      commits: [],
    });
    expect(report).toMatchObject({ due: false, proposedVersion: "3.14.0" });
  });

  it("prefers the already-bumped package.json version over a smaller inferred version", () => {
    const report = buildPackageReleaseReport({
      config: engineConfig,
      latestTag: { tag: "engine-v3.14.0", version: "3.14.0" },
      packageVersion: "4.0.0", // a manual/release-please major bump already committed
      publishedVersion: "3.14.0",
      commits: [commit("fix(engine): tiny fix (#5)", ["packages/loopover-engine/src/foo.ts"])], // would only infer a patch bump
    });
    expect(report.proposedVersion).toBe("4.0.0");
  });

  it("escapes untrusted commit subjects in the release-due issue", () => {
    const maliciousSubject = "feat(engine): notify @octocat [SECURITY ACTION REQUIRED](https://evil.example/phish) #123";
    const report = buildPackageReleaseReport({
      config: engineConfig,
      latestTag: { tag: "engine-v3.14.0", version: "3.14.0" },
      packageVersion: "3.14.0",
      publishedVersion: "3.14.0",
      commits: [commit(maliciousSubject, ["packages/loopover-engine/src/foo.ts"])],
    });
    const issue = buildPackageReleaseIssue(report, engineConfig);

    expect(issue.body).not.toContain(maliciousSubject);
    expect(issue.body).toContain("@\u200boctocat");
    expect(issue.body).toContain("\\[SECURITY ACTION REQUIRED\\]\\(https://evil\\.example/phish\\)");
  });

  it("falls back to placeholder text when there are no commits or changed files", () => {
    const report = buildPackageReleaseReport({
      config: PACKAGE_RELEASE_CONFIGS["ui-kit"],
      latestTag: { tag: "ui-kit-v1.1.2", version: "1.1.2" },
      packageVersion: "1.1.2",
      publishedVersion: "1.1.1",
      commits: [],
    });
    const issue = buildPackageReleaseIssue(report, PACKAGE_RELEASE_CONFIGS["ui-kit"]);
    expect(issue.body).toContain("- No unreleased ui-kit-related commits detected.");
    expect(issue.body).toContain("- No changed files detected.");
  });

  it("only updates the bot-owned release reminder issue, scoped by this package's own marker", () => {
    expect(
      isReleaseWatchIssue(
        { title: "Engine release due: 3.15.0", body: "<!-- loopover:engine-release-due -->", user: { login: "github-actions[bot]" } },
        engineConfig,
      ),
    ).toBe(true);
    // A different package's marker must not cross-match.
    expect(
      isReleaseWatchIssue(
        { title: "Miner release due: 3.15.0", body: "<!-- loopover:miner-release-due -->", user: { login: "github-actions[bot]" } },
        engineConfig,
      ),
    ).toBe(false);
    expect(
      isReleaseWatchIssue(
        { title: "Engine release due: 3.15.0", body: "<!-- loopover:engine-release-due -->", user: { login: "public-contributor" } },
        engineConfig,
      ),
    ).toBe(false);
  });
});

describe("closeResolvedIssueIfPresent (#8591, mirrors #6145's fix for MCP)", () => {
  const resolvedReport = {
    due: false,
    proposedVersion: "3.14.0",
    latestTag: "engine-v3.14.0",
    latestTagVersion: "3.14.0",
    packageVersion: "3.14.0",
    publishedVersion: "3.14.0",
    releaseType: null,
    commits: [],
    changedFiles: [],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;
  });

  it("comments and closes an existing open watch issue once the release has caught up", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    process.env.GITHUB_TOKEN = "test-token";
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (method === "GET") {
          return new Response(
            JSON.stringify([{ number: 555, title: "Engine release due: 4.0.0", body: "<!-- loopover:engine-release-due -->", user: { login: "github-actions[bot]" } }]),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await closeResolvedIssueIfPresent(resolvedReport, engineConfig);

    expect(calls).toHaveLength(3);
    const commentCall = calls.find((call) => call.method === "POST" && call.url.includes("/comments"));
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(commentCall?.url).toContain("/issues/555/comments");
    expect(commentCall?.body).toMatchObject({ body: expect.stringContaining("caught up") });
    expect(patchCall?.url).toContain("/issues/555");
    expect(patchCall?.body).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("does nothing when no open watch issue exists", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await closeResolvedIssueIfPresent(resolvedReport, engineConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an open issue whose marker belongs to a different package", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ number: 9, title: "Miner release due: 4.0.0", body: "<!-- loopover:miner-release-due -->", user: { login: "github-actions[bot]" } }]), { status: 200 }),
      )
      .mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await closeResolvedIssueIfPresent(resolvedReport, engineConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
