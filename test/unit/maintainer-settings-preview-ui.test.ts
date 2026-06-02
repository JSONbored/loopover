import { describe, expect, it } from "vitest";

import {
  buildSettingsPreviewRequest,
  extractPreviewRepoOptions,
  findPreviewScenario,
  parseLinkedIssues,
  parsePreviewLabels,
  splitRepoFullName,
} from "../../apps/gittensory-ui/src/lib/maintainer-settings-preview";

describe("maintainer settings preview UI helpers", () => {
  it("derives stable repo options from cached reviewability rows", () => {
    expect(
      extractPreviewRepoOptions([
        { pr: "entrius/allways-ui#12" },
        { pr: "JSONbored/gittensory#135" },
        { pr: "entrius/allways-ui#14" },
        { pr: "not-a-pr" },
      ]),
    ).toEqual(["entrius/allways-ui", "JSONbored/gittensory"]);
  });

  it("validates owner/repo input before the UI calls the dry-run endpoint", () => {
    expect(splitRepoFullName("JSONbored/gittensory")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
    });
    expect(splitRepoFullName("missing")).toBeNull();
    expect(splitRepoFullName("too/many/parts")).toBeNull();
  });

  it("normalizes labels and linked issue fields into the API request shape", () => {
    expect(parsePreviewLabels("bug, docs, BUG, area/frontend")).toEqual([
      "bug",
      "docs",
      "area/frontend",
    ]);
    expect(parseLinkedIssues("#7, 12 12 invalid 0 -1")).toEqual([7, 12]);
  });

  it("builds scenario-specific sample PR requests without private fields", () => {
    const request = buildSettingsPreviewRequest({
      repoFullName: "JSONbored/gittensory",
      scenarioId: "miner-api-unavailable",
      title: "  ",
      labels: "bug, privacy",
      linkedIssues: "#135",
      body: "wallet hotkey payout should be sanitized by the API preview",
    });

    expect(request).toEqual({
      sample: {
        authorLogin: "sample-miner",
        authorType: "User",
        authorAssociation: "CONTRIBUTOR",
        minerStatus: "unavailable",
        title: "Sample pull request",
        labels: ["bug", "privacy"],
        linkedIssues: [135],
        body: "wallet hotkey payout should be sanitized by the API preview",
      },
    });
  });

  it("keeps all required simulator scenarios available", () => {
    expect(findPreviewScenario("confirmed-miner").sample).toMatchObject({
      minerStatus: "confirmed",
      authorType: "User",
    });
    expect(findPreviewScenario("non-miner").sample).toMatchObject({
      minerStatus: "not_found",
    });
    expect(findPreviewScenario("bot-author").sample).toMatchObject({
      authorType: "Bot",
    });
    expect(findPreviewScenario("maintainer-author").sample).toMatchObject({
      authorAssociation: "OWNER",
    });
    expect(findPreviewScenario("miner-api-unavailable").sample).toMatchObject({
      minerStatus: "unavailable",
    });
  });

  it("falls back safely for sparse preview helper inputs", () => {
    expect(findPreviewScenario("unknown-scenario" as never).id).toBe("confirmed-miner");
    expect(
      extractPreviewRepoOptions([
        { pr: { split: () => [] } as unknown as string },
        { pr: "JSONbored/gittensory#251" },
      ]),
    ).toEqual(["JSONbored/gittensory"]);

    const request = buildSettingsPreviewRequest({
      repoFullName: "JSONbored/gittensory",
      scenarioId: "confirmed-miner",
      title: "Export weekly report",
      labels: "",
      linkedIssues: "",
      body: "   ",
    });
    expect(request.sample).not.toHaveProperty("body");
  });
});
