import { describe, expect, it } from "vitest";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { loadMaintainerNoiseReport, maintainerNoiseSummary } from "../../src/services/maintainer-noise";
import { createTestEnv } from "../helpers/d1";

describe("maintainer noise report serving", () => {
  it("loads repo signals and computes the noise report on demand", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    // An open PR with no linked issue and a broad/churn-style title → queue-noise sources.
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "misc cleanup and various refactors across modules", state: "open", user: { login: "alice" }, body: "" });
    const report = await loadMaintainerNoiseReport(env, "octo/demo");
    expect(report.repoFullName).toBe("octo/demo");
    expect(report.score).toBeGreaterThan(0);
    expect(["low", "medium", "high", "critical"]).toContain(report.level);
    expect(report.noiseSources.length).toBeGreaterThan(0);
    // Public-safe: no private economic/identity terms leak through.
    expect(JSON.stringify(report)).not.toMatch(/wallet|hotkey|coldkey|payout|reward|trust score/i);
  });

  it("returns a clean-queue report (no noise sources) for a repo with no open PRs", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "quiet", full_name: "octo/quiet", private: false, owner: { login: "octo" }, default_branch: "main" });
    const report = await loadMaintainerNoiseReport(env, "octo/quiet");
    expect(report.repoFullName).toBe("octo/quiet");
    expect(report.level).toBe("low");
    expect(report.noiseSources).toEqual([expect.stringMatching(/No major maintainer-noise source/i)]);
  });

  it("renders a public-safe one-line summary", () => {
    const summary = maintainerNoiseSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-01T00:00:00.000Z",
      score: 42,
      level: "medium",
      noiseSources: ["a", "b"],
      maintainerActions: ["review_now"],
      queueHealth: {} as never,
      summary: "",
    });
    expect(summary).toContain("octo/demo");
    expect(summary).toContain("medium");
    expect(summary).toContain("42");
    expect(summary).toContain("2 source(s)");
  });
});
