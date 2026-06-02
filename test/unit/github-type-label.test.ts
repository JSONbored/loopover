import { describe, expect, it } from "vitest";
import { applyTypeLabel, classifyTypeLabel, getTypeLabelDecision, readCurrentLabels } from "../../scripts/github-type-label.mjs";

describe("GitHub type label classifier", () => {
  it.each([
    ["[Bug]: ensurePullRequestLabel misses labels beyond first page"],
    ["fix(auth): trim bearer tokens in rate-limit keys"],
    ["fix: handle stale queue rows"],
    ["bug(api): preserve malformed request errors"],
    ["bug: reject missing event payload"],
  ])("classifies bug titles: %s", (title) => {
    expect(classifyTypeLabel(title)).toBe("bug");
  });

  it.each([
    ["[Feature]: add maintainer queue filters"],
    ["feat(agent): add action portfolio"],
    ["feat: add agent action explanation cards"],
    ["feature(ui): add sidebar context panel"],
    ["feature: add digest-ready queue notifications"],
  ])("classifies feature titles: %s", (title) => {
    expect(classifyTypeLabel(title)).toBe("feature");
  });

  it("does not overwrite an existing type label", () => {
    expect(classifyTypeLabel("feat(api): add queue filters", [{ name: "bug" }])).toBeNull();
    expect(classifyTypeLabel("fix(api): repair queue filters", [{ name: "feature" }])).toBeNull();
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

  it("handles pull_request_target payloads directly", () => {
    expect(
      getTypeLabelDecision("pull_request_target", {
        pull_request: {
          number: 42,
          title: "feat(mcp): add metadata boundary checks",
          labels: [{ name: "size:S" }],
        },
      }),
    ).toEqual({
      action: "apply",
      label: "feature",
      number: 42,
      title: "feat(mcp): add metadata boundary checks",
    });
  });

  it("does not post when a current type label already exists", async () => {
    const calls: string[] = [];
    const result = await applyTypeLabel({
      repository: "JSONbored/gittensory",
      token: "token",
      number: 42,
      label: "feature",
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
        if ((init?.method ?? "GET") === "GET") return Response.json([{ name: "bug" }]);
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
      label: "feature",
      fetchImpl: async (input, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${input.toString()}`);
        if (method === "GET") return Response.json([{ name: "size:S" }]);
        if (method === "POST") {
          expect(JSON.parse(String(init?.body))).toEqual({ labels: ["feature"] });
          return Response.json([{ name: "feature" }]);
        }
        return new Response("unexpected method", { status: 500 });
      },
    });

    expect(result).toEqual({ applied: true });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100",
      "POST https://api.github.com/repos/JSONbored/gittensory/issues/42/labels",
    ]);
  });

  it("reads paginated current labels before deciding to post", async () => {
    const calls: string[] = [];
    const labels = await readCurrentLabels({
      issueLabelsUrl: "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels",
      headers: { authorization: "Bearer token" },
      fetchImpl: async (input) => {
        calls.push(input.toString());
        if (input.toString().endsWith("page=2")) return Response.json([{ name: "feature" }]);
        return Response.json([{ name: "size:S" }], {
          headers: {
            link: '<https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100&page=2>; rel="next"',
          },
        });
      },
    });

    expect(labels).toEqual(["size:s", "feature"]);
    expect(calls).toEqual([
      "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100",
      "https://api.github.com/repos/JSONbored/gittensory/issues/42/labels?per_page=100&page=2",
    ]);
  });
});
