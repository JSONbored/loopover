import { describe, expect, it } from "vitest";
import { buildIssueRagQuery } from "../../src/review/issue-rag-wire";

describe("buildIssueRagQuery (#2320)", () => {
  it("uses a sufficiently descriptive title when the issue has an empty body", () => {
    expect(
      buildIssueRagQuery({
        title: "Add observability context for self-hosted review planning failures",
        body: "",
      }),
    ).toEqual({
      queryText: "Add observability context for self-hosted review planning failures",
    });
  });

  it("prepends the issue title, includes the body, and appends labels as a hint line", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
      labels: ["gittensor:feature", "selfhost", "  "],
    });

    expect(queryText).toContain("Improve SQLite backup readiness checks");
    expect(queryText).toContain("Operators need restore guidance");
    expect(queryText).toContain("Labels: gittensor:feature, selfhost");
    expect(queryText.indexOf("Improve SQLite")).toBeLessThan(queryText.indexOf("Operators need"));
    expect(queryText.indexOf("Operators need")).toBeLessThan(queryText.indexOf("Labels:"));
  });

  it("bounds long issue bodies without dropping the label hint", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Investigate flaky queue dispatch telemetry",
      body: `${"a".repeat(4100)}SHOULD_NOT_APPEAR`,
      labels: ["queue"],
    });

    expect(queryText).toContain("Investigate flaky queue dispatch telemetry");
    expect(queryText).toContain("Labels: queue");
    expect(queryText).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("returns an empty query for a one-line issue below the retrieval floor", () => {
    expect(buildIssueRagQuery({ title: "Tiny" })).toEqual({ queryText: "" });
  });

  it("uses a descriptive body when the title is blank and omits blank labels", () => {
    const { queryText } = buildIssueRagQuery({
      title: "   ",
      body: "Document how the miner should build issue context before a pull request exists.",
      labels: [" ", ""],
    });

    expect(queryText).toBe(
      "Document how the miner should build issue context before a pull request exists.",
    );
  });
});
