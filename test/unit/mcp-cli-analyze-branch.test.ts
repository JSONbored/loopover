import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, createPacketRepo, localBranchAnalysisFixture, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — analyze-branch --format table", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  // A richer analysis than the default fixture so the table exercises multiple next-action rows,
  // a right-aligned numeric priority column, and the analyze-branch-only score-blockers table.
  const analysisFixture = () => ({
    ...localBranchAnalysisFixture(),
    nextActions: [
      { actionKind: "prepare_pr_packet", priorityScore: 12, whyThisHelps: ["Keeps public packet safe."] },
      { actionKind: "add_tests", whyThisHelps: ["Raise branch coverage."] },
    ],
    scoreBlockers: ["Add a linked issue.", "Increase test evidence."],
  });

  const env = (url: string) => ({ LOOPOVER_API_URL: url, LOOPOVER_TOKEN: "session-token", LOOPOVER_SKIP_NPM_VERSION_CHECK: "true" });
  const args = (extra: string[]) => ["analyze-branch", "--login", "JSONbored", "--cwd", tempDir as string, "--repo", "JSONbored/gittensory", ...extra];

  it("renders next actions and score blockers as aligned tables", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ localBranchAnalysis: analysisFixture() });
    const output = await runAsync(args(["--format", "table"]), env(url));
    const lines = output.split("\n");

    // Next-actions table: header, then one aligned row per action with a right-aligned priority.
    expect(lines).toContain("Action             Priority  Why this helps");
    expect(lines).toContain("prepare_pr_packet        12  Keeps public packet safe.");
    expect(lines).toContain("add_tests                 —  Raise branch coverage.");
    // Score-blockers table (analyze-branch only).
    expect(lines).toContain("Score blocker");
    expect(lines).toContain("Add a linked issue.");
    expect(lines).toContain("Increase test evidence.");
    // The line-summary renderer's labels must not appear in table mode.
    expect(output).not.toContain("Top action:");
  });

  it("accepts the inline --format=table form", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ localBranchAnalysis: analysisFixture() });
    const output = await runAsync(args(["--format=table"]), env(url));
    expect(output).toContain("Action             Priority  Why this helps");
    expect(output).toContain("prepare_pr_packet        12  Keeps public packet safe.");
  });

  it("leaves the default line-summary output unchanged", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ localBranchAnalysis: analysisFixture() });
    const output = await runAsync(args([]), env(url));
    // Existing behavior: summary + "Top action:" line + colon-labelled sections, and no aligned table.
    expect(output).toContain("Local branch preflight fixture.");
    expect(output).toContain("Top action: prepare_pr_packet");
    expect(output).toContain("Score blockers:");
    expect(output).not.toContain("Action             Priority  Why this helps");
    expect(output).not.toContain("prepare_pr_packet        12");
  });

  it("leaves the --json output unchanged", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ localBranchAnalysis: analysisFixture() });
    const output = await runAsync(args(["--json"]), env(url));
    const payload = JSON.parse(output) as { analysis: { summary: string; scoreBlockers: string[] } };
    expect(payload.analysis.summary).toBe("Local branch preflight fixture.");
    expect(payload.analysis.scoreBlockers).toEqual(["Add a linked issue.", "Increase test evidence."]);
    expect(output).not.toContain("Action             Priority  Why this helps");
  });
});
