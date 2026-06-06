import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyTypeLabel,
  classifyTypeLabel,
  ensureRepositoryLabel,
  extractClosingIssueNumbers,
  fetchReferencedIssues,
  getTypeLabelDecision,
  readCurrentLabels,
} from "../../scripts/github-type-label.mjs";

describe("GitHub type label classifier", () => {
  it.each([
    ["[Bug]: ensurePullRequestLabel misses labels beyond first page"],
    ["fix(auth): trim bearer tokens in rate-limit keys"],
    ["fix: handle stale queue rows"],
    ["bug(api): preserve malformed request errors"],
    ["bug: reject missing event payload"],
  ])("classifies bug titles: %s", (title) => {
    expect(classifyTypeLabel(title)).toBe("gittensor:bug");
  });

  it.each([
    ["[Feature]: add maintainer queue filters"],
    ["feat(agent): add action portfolio"],
    ["feat: add agent action explanation cards"],
    ["feature(ui): add sidebar context panel"],
    ["feature: add digest-ready queue notifications"],
  ])("classifies feature titles: %s", (title) => {
    expect(classifyTypeLabel(title)).toBe("gittensor:feature");
  });

  it("does not overwrite an existing type label", () => {
    expect(classifyTypeLabel("feat(api): add queue filters", [{ name: "gittensor:bug" }])).toBeNull();
    expect(classifyTypeLabel("fix(api): repair queue filters", [{ name: "gittensor:feature" }])).toBeNull();
    expect(classifyTypeLabel("fix(api): repair queue filters", [{ name: "gittensor:priority" }])).toBeNull();
  });

  it("skips ambiguous titles", () => {
    expect(classifyTypeLabel("Improve queue filters")).toBeNull();
    expect(classifyTypeLabel("prefix fix: this should not match")).toBeNull();
  });

  it("ignores issue events that are actually pull request issue payloads", () => {
    expect(
      getTypeLabelDecision("issues", {
        issue: {
          number: 12,
          title: "fix(api): trim input",
          labels: [],
          pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/12" },
        },
      }),
    ).toMatchObject({ action: "skip", reason: "issue-is-pull-request" });
  });

  it("applies bug labels to pull_request_target payloads directly", () => {
    expect(
      getTypeLabelDecision("pull_request_target", {
        pull_request: {
          number: 42,
          title: "fix(mcp): repair metadata boundary checks",
          labels: [{ name: "size:S" }],
        },
      }),
    ).toEqual({
      action: "apply",
      label: "gittensor:bug",
      number: 42,
      title: "fix(mcp): repair metadata boundary checks",
    });
  });

  it("requires a linked feature issue before labeling feature pull requests", () => {
    const payload = {
      pull_request: {
        number: 43,
        title: "feat(mcp): add metadata boundary checks",
        labels: [{ name: "size:S" }],
      },
    };

    expect(getTypeLabelDecision("pull_request_target", payload)).toEqual({
      action: "skip",
      reason: "feature-pr-missing-feature-issue",
      number: 43,
      title: "feat(mcp): add metadata boundary checks",
    });

    expect(
      getTypeLabelDecision("pull_request_target", payload, {
        issueReferences: [{ number: 12, title: "[Feature]: add metadata boundary checks", labels: [{ name: "feature" }] }],
      }),
    ).toEqual({
      action: "apply",
      label: "gittensor:feature",
      number: 43,
      title: "feat(mcp): add metadata boundary checks",
    });
  });

  it("grants the workflow permission to write pull request labels", () => {
    const workflow = readFileSync(".github/workflows/type-label.yml", "utf8");

    expect(workflow).toMatch(/pull_request_target:/);
    expect(workflow).toMatch(/issues:\s+write/);
    expect(workflow).toMatch(/pull-requests:\s+write/);
    expect(workflow).toContain("Checkout base branch");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/npm\s+(ci|install)/);
  });

  it("does not post when a current type label already exists", async () => {
    const calls: string[] = [];
    const result = await applyTypeLabel({
      repository: "JSONbored/gittensory",
      token: "token",
      number: 42,
      label: "gittensor:feature",
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
        if ((init?.method ?? "GET") === "GET") return Response.json([{ name: "gittensor:bug" }]);
        return new Response("unexpected post", { status: 500 });
      },
    });

    expect(result).toEqual({ applied: false, reason: "type-label-already-present" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/repos/JSONbored/gittensory/issues/42/labels?per_page=100");
  });

  it("posts the target label when current labels have no type label", async () => {
    const calls: string[] = [];
    const result = await applyTypeLabel({
      repository: "JSONbored/gittensory",
      token: "token",
      number: 42,
      label: "gittensor:feature",
      fetchImpl: async (input, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${input.toString()}`);
        if (method === "GET" && input.toString().includes("/issues/42/labels")) return Response.json([{ name: "size:S" }]);
        if (method === "GET" && input.toString().includes("/labels/gittensor%3Afeature")) return Response.json({ name: "gittensor:feature" });
        if (method === "POST") {
          expect(JSON.parse(String(init?.body))).toEqual({ labels: ["gittensor:feature"] });
          return Response.json([{ name: "gittensor:feature" }]);
        }
        return new Response("unexpected method", { status: 500 });
      },
    });

    expect(result).toEqual({ applied: true });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100",
      "GET https://api.github.com/repos/JSONbored/gittensory/labels/gittensor%3Afeature",
      "POST https://api.github.com/repos/JSONbored/gittensory/issues/42/labels",
    ]);
  });

  it("does not fail the workflow when GitHub forbids a fork PR label write", async () => {
    const calls: string[] = [];
    const result = await applyTypeLabel({
      repository: "JSONbored/gittensory",
      token: "token",
      number: 263,
      label: "gittensor:feature",
      fetchImpl: async (input, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${input.toString()}`);
        if (method === "GET" && input.toString().includes("/issues/263/labels")) return Response.json([{ name: "size:S" }]);
        if (method === "GET" && input.toString().includes("/labels/gittensor%3Afeature")) return Response.json({ name: "gittensor:feature" });
        if (method === "POST") {
          return Response.json(
            {
              message: "Resource not accessible by integration",
              documentation_url: "https://docs.github.com/rest/issues/labels#add-labels-to-an-issue",
              status: "403",
            },
            { status: 403 },
          );
        }
        return new Response("unexpected method", { status: 500 });
      },
    });

    expect(result).toEqual({ applied: false, reason: "label-write-forbidden" });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/JSONbored/gittensory/issues/263/labels?per_page=100",
      "GET https://api.github.com/repos/JSONbored/gittensory/labels/gittensor%3Afeature",
      "POST https://api.github.com/repos/JSONbored/gittensory/issues/263/labels",
    ]);
  });

  it("still fails on unexpected label write errors", async () => {
    await expect(
      applyTypeLabel({
        repository: "JSONbored/gittensory",
        token: "token",
        number: 42,
        label: "gittensor:feature",
        fetchImpl: async (_input, init) => {
          const method = init?.method ?? "GET";
          if (method === "GET") return Response.json([{ name: "size:S" }]);
          return new Response("server error", { status: 500 });
        },
      }),
    ).rejects.toThrow("Failed to apply gittensor:feature to #42: 500 server error");
  });

  it("reads paginated current labels before deciding to post", async () => {
    const calls: string[] = [];
    const labels = await readCurrentLabels({
      issueLabelsUrl: "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels",
      headers: { authorization: "Bearer token" },
      fetchImpl: async (input) => {
        calls.push(input.toString());
        if (input.toString().endsWith("page=2")) return Response.json([{ name: "gittensor:feature" }]);
        return Response.json([{ name: "size:S" }], {
          headers: {
            link: '<https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100&page=2>; rel="next"',
          },
        });
      },
    });

    expect(labels).toEqual(["size:s", "gittensor:feature"]);
    expect(calls).toEqual([
      "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100",
      "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100&page=2",
    ]);
  });

  it("extracts closing issue references for feature PR qualification", () => {
    expect(extractClosingIssueNumbers("Closes #12, fixes #13, refs #14, resolves #12")).toEqual([12, 13]);
  });

  it("fetches referenced issues from closing references", async () => {
    const calls: string[] = [];
    const issues = await fetchReferencedIssues({
      repository: "JSONbored/gittensory",
      token: "token",
      body: "Closes #12",
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
        return Response.json({ number: 12, title: "[Feature]: add metadata boundary checks", labels: [{ name: "feature" }] });
      },
    });

    expect(issues).toEqual([{ number: 12, title: "[Feature]: add metadata boundary checks", labels: [{ name: "feature" }] }]);
    expect(calls).toEqual(["GET https://api.github.com/repos/JSONbored/gittensory/issues/12"]);
  });

  it("creates a missing auto reward label before applying it", async () => {
    const calls: string[] = [];
    const result = await ensureRepositoryLabel({
      owner: "JSONbored",
      repo: "gittensory",
      headers: { authorization: "Bearer token" },
      label: "gittensor:bug",
      fetchImpl: async (input, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${input.toString()}`);
        if (method === "GET") return new Response("not found", { status: 404 });
        if (method === "POST") {
          expect(JSON.parse(String(init?.body))).toEqual({
            name: "gittensor:bug",
            color: "d73a4a",
            description: "Gittensor-scored bug fix",
          });
          return Response.json({ name: "gittensor:bug" }, { status: 201 });
        }
        return new Response("unexpected method", { status: 500 });
      },
    });

    expect(result).toEqual({ created: true });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/JSONbored/gittensory/labels/gittensor%3Abug",
      "POST https://api.github.com/repos/JSONbored/gittensory/labels",
    ]);
  });
});
