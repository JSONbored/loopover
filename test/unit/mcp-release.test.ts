import { afterEach, describe, expect, it, vi } from "vitest";
import { closeResolvedIssueIfPresent, isReleaseWatchIssue } from "../../scripts/check-mcp-release-due.js";
import { buildMcpReleaseIssue, buildMcpReleaseReport, renderMcpChangelog, selectMcpReleaseCommits } from "../../scripts/mcp-release-core.js";

type TestCommit = {
  sha: string;
  subject: string;
  files: string[];
};

function commit(subject: string, files: string[], sha = subject): TestCommit {
  return { sha: sha.padEnd(40, "0").slice(0, 40), subject, files };
}

describe("MCP release changelog detection", () => {
  it("includes package-only MCP package changes", () => {
    const commits = selectMcpReleaseCommits([commit("docs(ci): add MCP package usage note (#1)", ["packages/loopover-mcp/README.md"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["docs(ci): add MCP package usage note (#1)"]);
  });

  it("includes MCP server tool changes", () => {
    const commits = selectMcpReleaseCommits([commit("feat(mcp): add branch eligibility tool (#2)", ["src/mcp/server.ts"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["feat(mcp): add branch eligibility tool (#2)"]);
  });

  it("includes compatibility metadata changes", () => {
    const commits = selectMcpReleaseCommits([commit("feat(analytics): track MCP compatibility adoption (#3)", ["src/services/mcp-compatibility.ts"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["feat(analytics): track MCP compatibility adoption (#3)"]);
  });

  it("excludes UI-only changes", () => {
    const commits = selectMcpReleaseCommits([
      commit("feat(ui): add release dashboard card (#4)", ["apps/loopover-ui/src/routes/app.operator.tsx", "apps/loopover-ui/public/openapi.json"]),
    ]);

    expect(commits).toEqual([]);
  });

  it("excludes test-only support changes even when they touch local signal helpers", () => {
    const commits = selectMcpReleaseCommits([commit("test(coverage): raise website closeout gates (#5)", ["src/signals/local-branch.ts", "test/unit/local-branch.test.ts"])]);

    expect(commits).toEqual([]);
  });

  it("preserves previous release sections byte-for-byte", () => {
    const priorSections = `## mcp-v0.3.0 - 2026-05-31

### Features
- Existing feature text

## mcp-v0.2.0 - 2026-05-29

### Fixes
- Existing fix text
`;
    const changelog = renderMcpChangelog({
      existingChangelog: `# Changelog\n\n${priorSections}`,
      targetVersion: "0.4.0",
      generatedAt: "2026-06-02",
      commits: [commit("feat(mcp): add local workspace intelligence v2 (#70)", ["packages/loopover-mcp/bin/loopover-mcp.js"])],
    });

    expect(changelog).toContain("## mcp-v0.4.0 - 2026-06-02");
    expect(changelog.slice(changelog.indexOf("## mcp-v0.3.0"))).toBe(priorSections);
  });

  it("builds a release-due issue with the version and checklist", () => {
    const report = buildMcpReleaseReport({
      latestTag: { tag: "mcp-v0.3.0", version: "0.3.0" },
      packageVersion: "0.4.0",
      publishedVersion: "0.3.0",
      commits: [commit("feat(mcp): add local workspace intelligence v2 (#70)", ["src/mcp/server.ts"])],
    });
    const issue = buildMcpReleaseIssue(report);

    expect(report).toMatchObject({ due: true, proposedVersion: "0.4.0", releaseType: "minor" });
    expect(issue.title).toBe("MCP release due: 0.4.0");
    expect(issue.body).toContain("<!-- loopover:mcp-release-due -->");
    expect(issue.body).toContain("- [ ] Run `npm run test:release:mcp`");
    expect(issue.body).toContain("- [ ] Tag `mcp-v0.4.0`");
  });

  it("escapes untrusted commit subjects in the release-due issue", () => {
    const maliciousSubject = "feat(mcp): notify @octocat [SECURITY ACTION REQUIRED](https://evil.example/phish) #123";
    const report = buildMcpReleaseReport({
      latestTag: { tag: "mcp-v0.3.0", version: "0.3.0" },
      packageVersion: "0.4.0",
      publishedVersion: "0.3.0",
      commits: [commit(maliciousSubject, ["src/mcp/server.ts"])],
    });
    const issue = buildMcpReleaseIssue(report);

    expect(issue.body).not.toContain(maliciousSubject);
    expect(issue.body).toContain("@\u200boctocat");
    expect(issue.body).toContain("\\[SECURITY ACTION REQUIRED\\]\\(https://evil\\.example/phish\\)");
    expect(issue.body).toContain("\\#123");
  });

  it("only updates the bot-owned release reminder issue", () => {
    expect(
      isReleaseWatchIssue({
        title: "MCP release due: 0.4.0",
        body: "<!-- loopover:mcp-release-due -->",
        user: { login: "github-actions[bot]" },
      }),
    ).toBe(true);

    expect(
      isReleaseWatchIssue({
        title: "MCP release due: 0.4.0",
        body: "<!-- loopover:mcp-release-due -->",
        user: { login: "public-contributor" },
      }),
    ).toBe(false);
  });
});

describe("closeResolvedIssueIfPresent (#6145 follow-up)", () => {
  const resolvedReport = {
    due: false,
    proposedVersion: "3.1.0",
    latestTag: "mcp-v3.1.0",
    latestTagVersion: "3.1.0",
    packageVersion: "3.1.0",
    publishedVersion: "3.1.0",
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
            JSON.stringify([
              {
                number: 6145,
                title: "MCP release due: 4.0.0",
                body: "<!-- loopover:mcp-release-due -->",
                user: { login: "github-actions[bot]" },
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await closeResolvedIssueIfPresent(resolvedReport);

    expect(calls).toHaveLength(3);
    const commentCall = calls.find((call) => call.method === "POST" && call.url.includes("/comments"));
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(commentCall?.url).toContain("/issues/6145/comments");
    expect(commentCall?.body).toMatchObject({ body: expect.stringContaining("caught up") });
    expect(patchCall?.url).toContain("/issues/6145");
    expect(patchCall?.body).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("does nothing when no open watch issue exists", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await closeResolvedIssueIfPresent(resolvedReport);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an open issue authored by someone other than github-actions[bot]", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    process.env.GITHUB_TOKEN = "test-token";
    // findExistingIssue pages until an empty page ends the search -- page 1 returns a non-matching
    // issue, page 2 must come back empty or the (real) pagination loop keeps requesting pages 3..10.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { number: 9, title: "MCP release due: 4.0.0", body: "<!-- loopover:mcp-release-due -->", user: { login: "someone-else" } },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await closeResolvedIssueIfPresent(resolvedReport);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
