import { describe, expect, it } from "vitest";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { MaintainerNoiseReport } from "../../src/signals/reward-risk";
import { loadMaintainerNoiseReport, maintainerNoiseSummary } from "../../src/services/maintainer-noise";
import { createTestEnv } from "../helpers/d1";

function report(overrides: Partial<MaintainerNoiseReport> = {}): MaintainerNoiseReport {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-01T00:00:00.000Z",
    score: 42,
    level: "medium",
    noiseSources: ["a", "b"],
    maintainerActions: ["review_now"],
    queueHealth: {} as never,
    summary: "",
    ...overrides,
  };
}

describe("maintainer noise report serving", () => {
  it("loads repo signals and computes the noise report on demand", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    // An open PR with no linked issue and a broad/churn-style title → queue-noise sources.
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "misc cleanup and various refactors across modules", state: "open", user: { login: "alice" }, body: "" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/demo");
    expect(rpt.repoFullName).toBe("octo/demo");
    expect(rpt.score).toBeGreaterThan(0);
    expect(["low", "medium", "high", "critical"]).toContain(rpt.level);
    expect(rpt.noiseSources.length).toBeGreaterThan(0);
    // Public-safe: no private economic/identity terms leak through.
    expect(JSON.stringify(rpt)).not.toMatch(/wallet|hotkey|coldkey|payout|reward|trust score/i);
  });

  it("returns a clean-queue report (no noise sources) for a repo with no open PRs", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "quiet", full_name: "octo/quiet", private: false, owner: { login: "octo" }, default_branch: "main" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/quiet");
    expect(rpt.repoFullName).toBe("octo/quiet");
    expect(rpt.level).toBe("low");
    expect(rpt.noiseSources).toEqual([expect.stringMatching(/No major maintainer-noise source/i)]);
  });

  it("flags unlinked open PRs as a noise source", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "fix: update button color", state: "open", user: { login: "alice" }, body: "" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/demo");
    expect(rpt.noiseSources.some((s) => s.includes("lack linked issue"))).toBe(true);
    expect(rpt.maintainerActions).toContain("needs_author");
  });

  it("flags broad-diff PRs (long title or refactor/cleanup keywords) as a noise source", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "refactor the entire authentication and session management pipeline for better separation of concerns", state: "open", user: { login: "alice" }, body: "" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/demo");
    expect(rpt.noiseSources.some((s) => /broad|hard to triage/i.test(s))).toBe(true);
  });

  it("emits needs_author action when there are unlinked open PRs", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "fix: update button color", state: "open", user: { login: "alice" }, body: "" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/demo");
    expect(rpt.maintainerActions).toContain("needs_author");
  });

  it("includes watch in maintainerActions when there are no noise sources", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "quiet", full_name: "octo/quiet", private: false, owner: { login: "octo" }, default_branch: "main" });
    const rpt = await loadMaintainerNoiseReport(env, "octo/quiet");
    expect(rpt.maintainerActions).toContain("watch");
  });
});

describe("maintainerNoiseSummary branch coverage", () => {
  it("renders the summary for each noise level (low, medium, high, critical)", () => {
    for (const level of ["low", "medium", "high", "critical"] as const) {
      const summary = maintainerNoiseSummary(report({ level, score: 50 }));
      expect(summary).toContain(level);
      expect(summary).toContain("octo/demo");
    }
  });

  it("renders score 0 without error", () => {
    const summary = maintainerNoiseSummary(report({ score: 0, level: "critical" }));
    expect(summary).toContain("score 0");
    expect(summary).toContain("critical");
  });

  it("renders 0 source(s) for an empty noise-sources array", () => {
    const summary = maintainerNoiseSummary(report({ noiseSources: [] }));
    expect(summary).toContain("0 source(s)");
  });

  it("renders 1 source(s) for a single-element noise-sources array", () => {
    const summary = maintainerNoiseSummary(report({ noiseSources: ["only one"] }));
    expect(summary).toContain("1 source(s)");
  });

  it("renders the repo full name in the summary", () => {
    const summary = maintainerNoiseSummary(report({ repoFullName: "org/repo-name" }));
    expect(summary).toContain("org/repo-name");
  });
});
