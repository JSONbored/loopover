import { describe, expect, it } from "vitest";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { buildLabelAudit, type LabelAudit } from "../../src/signals/engine";
import { labelAuditSummary, loadLabelAudit } from "../../src/services/label-audit";
import { createTestEnv } from "../helpers/d1";
import type { IssueRecord, PullRequestRecord, RepoLabelRecord, RepositoryRecord } from "../../src/types";

const noRepo = null;
const noLabels: RepoLabelRecord[] = [];
const noIssues: IssueRecord[] = [];
const noPRs: PullRequestRecord[] = [];

function repoWith(labelMultipliers: Record<string, number> | undefined, extras?: Partial<RepositoryRecord>): RepositoryRecord {
  return {
    fullName: "octo/demo",
    owner: "octo",
    name: "demo",
    isInstalled: false,
    isRegistered: true,
    isPrivate: false,
    registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0.25, labelMultipliers, maintainerCut: 0, raw: {} },
    ...extras,
  } as RepositoryRecord;
}

function label(name: string, observedCount = 0): RepoLabelRecord {
  return { repoFullName: "octo/demo", name, observedCount };
}

function issue(labels: string[]): IssueRecord {
  return { repoFullName: "octo/demo", number: 1, authorLogin: "alice", state: "open", labels, title: "", body: "", createdAt: "", updatedAt: "" } as unknown as IssueRecord;
}

function pr(labels: string[]): PullRequestRecord {
  return { repoFullName: "octo/demo", number: 2, authorLogin: "bob", state: "open", labels, title: "", body: "", createdAt: "", updatedAt: "", mergedAt: null } as unknown as PullRequestRecord;
}

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

describe("buildLabelAudit branch coverage", () => {
  it("returns empty arrays when repo is null (?? {} arm for labelMultipliers)", () => {
    const audit = buildLabelAudit(noRepo, noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.configuredLabels).toEqual([]);
    expect(audit.liveLabels).toEqual([]);
    expect(audit.observedLabels).toEqual([]);
    expect(audit.missingConfiguredLabels).toEqual([]);
    expect(audit.suspiciousConfiguredLabels).toEqual([]);
    expect(audit.trustedPipelineReady).toBe(false);
    expect(audit.findings).toEqual([]);
  });

  it("returns empty arrays when registryConfig or labelMultipliers is absent (?? {} arm)", () => {
    const repo = { ...repoWith(undefined), registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0.25, maintainerCut: 0, raw: {} } } as RepositoryRecord;
    const audit = buildLabelAudit(repo, noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.configuredLabels).toEqual([]);
    expect(audit.trustedPipelineReady).toBe(false);
  });

  it("surfaces added-only live labels that are not configured", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), [label("feature")], noIssues, noPRs, "octo/demo");
    expect(audit.liveLabels).toEqual(["feature"]);
    expect(audit.observedLabels.find((l) => l.name === "feature")).toMatchObject({ configured: false, existsOnGitHub: true });
    expect(audit.missingConfiguredLabels).toEqual(["bug"]);
  });

  it("surfaces removed-only configured labels missing from live GitHub labels", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2, docs: 1.0 }), [label("bug")], noIssues, noPRs, "octo/demo");
    expect(audit.missingConfiguredLabels).toEqual(["docs"]);
    expect(audit.liveLabels).toEqual(["bug"]);
  });

  it("treats all configured labels as present when all match live labels (unchanged set)", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2, docs: 1.0 }), [label("bug"), label("docs")], noIssues, noPRs, "octo/demo");
    expect(audit.missingConfiguredLabels).toEqual([]);
  });

  it("handles a mixed set: some configured labels present, some missing, some live-only", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2, docs: 1.0, "status:ready": 1.5 }), [label("bug"), label("feature")], noIssues, noPRs, "octo/demo");
    expect(audit.missingConfiguredLabels).toEqual(["docs", "status:ready"]);
    expect(audit.suspiciousConfiguredLabels).toEqual(["status:ready"]);
    expect(audit.observedLabels.find((l) => l.name === "bug")?.configured).toBe(true);
    expect(audit.observedLabels.find((l) => l.name === "feature")?.configured).toBe(false);
  });

  it("counts observed labels from both issues and pull requests (?? 0 arm for first-seen)", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), [label("bug", 2)], [issue(["bug", "bug"])], [pr(["bug"])], "octo/demo");
    const bugObserved = audit.observedLabels.find((l) => l.name === "bug");
    expect(bugObserved?.count).toBe(5);
  });

  it("resolves glob-pattern configured keys against live labels (type:* matches type:bug)", () => {
    const audit = buildLabelAudit(repoWith({ "type:*": 1.3 }), [label("type:bug")], noIssues, noPRs, "octo/demo");
    expect(audit.missingConfiguredLabels).toEqual([]);
    expect(audit.observedLabels.find((l) => l.name === "type:bug")?.configured).toBe(true);
  });

  it("flags glob-pattern configured keys as missing when no live label matches", () => {
    const audit = buildLabelAudit(repoWith({ "type:*": 1.3 }), [label("bug")], noIssues, noPRs, "octo/demo");
    expect(audit.missingConfiguredLabels).toEqual(["type:*"]);
  });

  it("detects suspicious status/source-style configured labels", () => {
    const audit = buildLabelAudit(repoWith({ "status:ready": 1, bot: 2, bug: 1.2 }), noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.suspiciousConfiguredLabels).toContain("status:ready");
    expect(audit.suspiciousConfiguredLabels).toContain("bot");
    expect(audit.suspiciousConfiguredLabels).not.toContain("bug");
  });

  it("does not flag mid-word matches like bottleneck or scoreboard as suspicious", () => {
    const audit = buildLabelAudit(repoWith({ bottleneck: 1, scoreboard: 1 }), noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.suspiciousConfiguredLabels).toEqual([]);
  });

  it("emits trusted_labels_missing finding when trustedLabelPipeline is set and labels are missing", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }, { registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0.25, labelMultipliers: { bug: 1.2 }, maintainerCut: 0, raw: {}, trustedLabelPipeline: true } } as RepositoryRecord), noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.findings.some((f) => f.code === "trusted_labels_missing")).toBe(true);
    expect(audit.trustedPipelineReady).toBe(false);
  });

  it("does not emit trusted_labels_missing when trustedLabelPipeline is absent", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.findings.some((f) => f.code === "trusted_labels_missing")).toBe(false);
  });

  it("emits suspicious_configured_labels finding when suspicious labels exist", () => {
    const audit = buildLabelAudit(repoWith({ "status:ready": 1 }), noLabels, noIssues, noPRs, "octo/demo");
    expect(audit.findings.some((f) => f.code === "suspicious_configured_labels")).toBe(true);
  });

  it("emits configured_labels_unused finding when configured labels exist but none are observed in cached work", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), [label("feature")], noIssues, noPRs, "octo/demo");
    expect(audit.findings.some((f) => f.code === "configured_labels_unused")).toBe(true);
  });

  it("does not emit configured_labels_unused when configured labels are observed in work", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), [label("bug")], [issue(["bug"])], noPRs, "octo/demo");
    expect(audit.findings.some((f) => f.code === "configured_labels_unused")).toBe(false);
  });

  it("marks trustedPipelineReady true when pipeline is set, no missing labels, and no suspicious labels", () => {
    const audit = buildLabelAudit(
      { ...repoWith({ bug: 1.2 }), registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0.25, labelMultipliers: { bug: 1.2 }, maintainerCut: 0, raw: {}, trustedLabelPipeline: true } } as RepositoryRecord,
      [label("bug")],
      [issue(["bug"])],
      noPRs,
      "octo/demo",
    );
    expect(audit.trustedPipelineReady).toBe(true);
    expect(audit.missingConfiguredLabels).toEqual([]);
    expect(audit.suspiciousConfiguredLabels).toEqual([]);
  });

  it("sorts observed labels by count desc then name asc", () => {
    const audit = buildLabelAudit(repoWith({ bug: 1.2 }), [label("bug", 1)], [issue(["docs", "docs", "bug"])], [pr(["docs"])], "octo/demo");
    const names = audit.observedLabels.map((l) => l.name);
    expect(names[0]).toBe("docs");
    expect(names[1]).toBe("bug");
  });
});
