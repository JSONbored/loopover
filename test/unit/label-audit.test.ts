import { describe, expect, it } from "vitest";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { LabelAudit } from "../../src/signals/engine";
import { labelAuditSummary, loadLabelAudit } from "../../src/services/label-audit";
import { createTestEnv } from "../helpers/d1";

describe("label audit serving", () => {
  it("loads repo labels and computes the audit on demand", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const report = await loadLabelAudit(env, "octo/demo");
    expect(report.repoFullName).toBe("octo/demo");
    expect(Array.isArray(report.configuredLabels)).toBe(true);
    expect(Array.isArray(report.suspiciousConfiguredLabels)).toBe(true);
    expect(Array.isArray(report.observedLabels)).toBe(true);
    expect(typeof report.trustedPipelineReady).toBe("boolean");
    // Public-safe: no private economic/identity terms leak through.
    expect(JSON.stringify(report)).not.toMatch(/wallet|hotkey|coldkey|payout|reward/i);
  });

  it("renders a public-safe summary for both trusted-pipeline-readiness states", () => {
    const base: LabelAudit = {
      repoFullName: "octo/demo",
      generatedAt: "2026-06-01T00:00:00.000Z",
      configuredLabels: ["bug", "status:ready"],
      liveLabels: ["status:ready"],
      observedLabels: [],
      missingConfiguredLabels: ["bug"],
      suspiciousConfiguredLabels: ["status:ready"],
      trustedPipelineReady: false,
      findings: [],
    };
    const notReady = labelAuditSummary(base);
    expect(notReady).toContain("octo/demo");
    expect(notReady).toContain("not ready");
    expect(notReady).toContain("1 missing");
    expect(notReady).toContain("1 suspicious");

    const ready = labelAuditSummary({ ...base, missingConfiguredLabels: [], suspiciousConfiguredLabels: [], trustedPipelineReady: true });
    expect(ready).toContain("pipeline ready");
    expect(ready).not.toContain("not ready");
  });
});
