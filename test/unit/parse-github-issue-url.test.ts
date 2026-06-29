import { describe, it, expect } from "vitest";
import { parseGitHubIssueUrl } from "../../src/upstream/ruleset";

describe("parseGitHubIssueUrl", () => {
  it("returns null for non-github.com URLs", () => {
    expect(parseGitHubIssueUrl("https://example.com/owner/repo/issues/123")).toBeNull();
    expect(parseGitHubIssueUrl("https://gitlab.com/owner/repo/issues/123")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGitHubIssueUrl("not-a-url")).toBeNull();
    expect(parseGitHubIssueUrl("")).toBeNull();
  });

  it("returns null for URLs with malformed issue numbers", () => {
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123abc")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/abc123")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/12.34")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/-123")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/0")).toBeNull();
  });

  it("returns null for URLs with extra path segments", () => {
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123/extra")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123/comments")).toBeNull();
  });

  it("returns null for URLs missing required segments", () => {
    expect(parseGitHubIssueUrl("https://github.com/owner/repo")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/")).toBeNull();
  });

  it("parses valid GitHub issue URLs correctly", () => {
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123")).toEqual({
      owner: "owner",
      name: "repo",
      number: 123,
    });
    expect(parseGitHubIssueUrl("https://github.com/JSONbored/gittensory/issues/1719")).toEqual({
      owner: "JSONbored",
      name: "gittensory",
      number: 1719,
    });
  });

  it("handles case-insensitive hostname", () => {
    expect(parseGitHubIssueUrl("https://GITHUB.COM/owner/repo/issues/123")).toEqual({
      owner: "owner",
      name: "repo",
      number: 123,
    });
    expect(parseGitHubIssueUrl("https://Github.Com/owner/repo/issues/456")).toEqual({
      owner: "owner",
      name: "repo",
      number: 456,
    });
  });

  it("rejects URLs with special characters in issue number", () => {
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123!")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/$123")).toBeNull();
    expect(parseGitHubIssueUrl("https://github.com/owner/repo/issues/123@")).toBeNull();
  });
});
