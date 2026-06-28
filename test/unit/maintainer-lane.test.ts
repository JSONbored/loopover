import { describe, expect, it } from "vitest";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { loadMaintainerLaneReport, maintainerLaneSummary } from "../../src/services/maintainer-lane";
import { createTestEnv } from "../helpers/d1";

describe("maintainer lane report serving", () => {
  it("loads repo signals and computes the lane report on demand", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "Fix retry backoff", state: "open", user: { login: "alice" }, body: "" });
    const report = await loadMaintainerLaneReport(env, "octo/demo");
    expect(report.repoFullName).toBe("octo/demo");
    // No maintainer_cut in the registry config → not configured, and a finding flags it.
    expect(report.maintainerCutConfigured).toBe(false);
    expect(report.findings.some((finding) => finding.code === "maintainer_cut_not_configured")).toBe(true);
    expect(report.lane).toBeTruthy();
    expect(report.queueHealth).toBeTruthy();
    expect(report.configQuality).toBeTruthy();
    expect(typeof report.contributorIntakeHealth.level).toBe("string");
    // Public-safe: no private economic/identity terms leak through.
    expect(JSON.stringify(report)).not.toMatch(/wallet|hotkey|coldkey|payout|reward|trust score/i);
  });

  it("renders a public-safe one-line summary", () => {
    const summary = maintainerLaneSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-01T00:00:00.000Z",
      lane: {} as never,
      maintainerCut: 0,
      maintainerCutConfigured: false,
      queueHealth: {} as never,
      configQuality: {} as never,
      contributorIntakeHealth: { level: "healthy" } as never,
      summary: "",
      findings: [],
    });
    expect(summary).toContain("octo/demo");
    expect(summary).toContain("not configured");
    expect(summary).toContain("healthy");

    // Cover the configured-cut side of the summary ternary.
    const configured = maintainerLaneSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-01T00:00:00.000Z",
      lane: {} as never,
      maintainerCut: 0.1,
      maintainerCutConfigured: true,
      queueHealth: {} as never,
      configQuality: {} as never,
      contributorIntakeHealth: { level: "developing" } as never,
      summary: "",
      findings: [],
    });
    expect(configured).toContain("maintainer_cut configured");
    expect(configured).not.toContain("not configured");
  });
});
