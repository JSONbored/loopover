import { describe, expect, it } from "vitest";

import {
  buildPlaygroundRequest,
  playgroundToolUsesPullNumber,
  playgroundToolUsesScenario,
  sampleBranchAnalysisBody,
  type PlaygroundToolId,
} from "../../src/ui/playground-tools";

describe("playground tool requests", () => {
  const base = {
    login: "jsonbored",
    repoFullName: "JSONbored/gittensory",
    branchName: "feat/issue-133",
    scenario: "gated" as const,
  };

  it("maps agent, intelligence, decision, branch, and packet tools to canonical paths", () => {
    expect(buildPlaygroundRequest({ ...base, tool: "decision-pack" })).toEqual({
      method: "GET",
      path: "/v1/contributors/jsonbored/decision-pack",
    });
    expect(buildPlaygroundRequest({ ...base, tool: "repo-intelligence" })).toEqual({
      method: "GET",
      path: "/v1/repos/JSONbored/gittensory/intelligence",
    });
    expect(buildPlaygroundRequest({ ...base, tool: "branch-analysis" }).path).toBe(
      "/v1/local/branch-analysis",
    );
    expect(buildPlaygroundRequest({ ...base, tool: "maintainer-packet", pullNumber: 12 })).toEqual({
      method: "GET",
      path: "/v1/repos/JSONbored/gittensory/pulls/12/maintainer-packet",
    });
    expect(buildPlaygroundRequest({ ...base, tool: "prepare-pr-packet" }).path).toBe(
      "/v1/agent/prepare-pr-packet",
    );
  });

  it("never embeds source file contents in branch-analysis samples", () => {
    const body = sampleBranchAnalysisBody(base);
    expect(JSON.stringify(body)).not.toMatch(/export |import |function |const /);
    expect(body.changedFiles.every((f) => typeof f.path === "string")).toBe(true);
  });

  it("flags scenario and pull number fields only for relevant tools", () => {
    expect(playgroundToolUsesScenario("plan-next-work")).toBe(true);
    expect(playgroundToolUsesScenario("decision-pack")).toBe(false);
    expect(playgroundToolUsesPullNumber("maintainer-packet")).toBe(true);
    expect(playgroundToolUsesPullNumber("repo-intelligence")).toBe(false);
  });

  it("rejects malformed repo names", () => {
    expect(() =>
      buildPlaygroundRequest({ ...base, repoFullName: "no-slash", tool: "repo-intelligence" }),
    ).toThrow(/owner\/repo/i);
  });

  it("covers public-safe comment and default maintainer pull number", () => {
    expect(buildPlaygroundRequest({ ...base, tool: "public-safe-comment" })).toEqual({
      method: "POST",
      path: "/v1/app/commands/preview",
      body: {
        command: "public-summary",
        repoFullName: base.repoFullName,
        login: base.login,
      },
    });
    expect(buildPlaygroundRequest({ ...base, tool: "maintainer-packet" }).path).toMatch(
      /\/pulls\/1\/maintainer-packet$/,
    );
    expect(buildPlaygroundRequest({ ...base, tool: "explain-blockers" }).path).toBe(
      "/v1/agent/explain-blockers",
    );
    expect(buildPlaygroundRequest({ ...base, tool: "preflight-branch" }).path).toBe(
      "/v1/agent/preflight-branch",
    );
    expect(buildPlaygroundRequest({ ...base, tool: "plan-next-work" }).path).toBe(
      "/v1/agent/plan-next-work",
    );
  });

  it("rejects unknown tool ids at runtime", () => {
    expect(() =>
      buildPlaygroundRequest({
        ...base,
        tool: "not-a-real-tool" as PlaygroundToolId,
      }),
    ).toThrow(/Unknown playground tool/i);
  });
});
