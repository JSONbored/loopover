import { describe, expect, it } from "vitest";
import { isReleaseWatchIssue } from "../../scripts/check-mcp-release-due.mjs";
import { buildMcpReleaseIssue, buildMcpReleaseReport, renderMcpChangelog, selectMcpReleaseCommits } from "../../scripts/mcp-release-core.mjs";

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
    const commits = selectMcpReleaseCommits([commit("docs(ci): add MCP package usage note (#1)", ["packages/gittensory-mcp/README.md"])]);

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
      commit("feat(ui): add release dashboard card (#4)", ["apps/gittensory-ui/src/routes/app.operator.tsx", "apps/gittensory-ui/public/openapi.json"]),
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
      commits: [commit("feat(mcp): add local workspace intelligence v2 (#70)", ["packages/gittensory-mcp/bin/gittensory-mcp.js"])],
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
    expect(issue.body).toContain("<!-- gittensory:mcp-release-due -->");
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
        body: "<!-- gittensory:mcp-release-due -->",
        user: { login: "github-actions[bot]" },
      }),
    ).toBe(true);

    expect(
      isReleaseWatchIssue({
        title: "MCP release due: 0.4.0",
        body: "<!-- gittensory:mcp-release-due -->",
        user: { login: "public-contributor" },
      }),
    ).toBe(false);
  });
});
