import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const observabilityDocPath = join(repoRoot, "packages/gittensory-miner/docs/observability.md");
const codingAgentDriverDocPath = join(repoRoot, "packages/gittensory-miner/docs/coding-agent-driver.md");
const envReferenceDocPath = join(repoRoot, "packages/gittensory-miner/docs/env-reference.md");
const minerUsageDashboardPath = join(repoRoot, "grafana/dashboards/miner-usage.json");
const sqliteProvisioningPath = join(repoRoot, "grafana/provisioning/datasources/sqlite.yml");
const dashboardProviderPath = join(repoRoot, "grafana/provisioning/dashboards/provider.yml");

describe("miner observability docs (#5190)", () => {
  it("ships observability.md with concrete Grafana + SQLite setup steps", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    expect(doc).toMatch(/^# Observing your miner/m);
    expect(doc).toContain("frser-sqlite-datasource");
    expect(doc).toContain("attempt-log.sqlite3");
    expect(doc).toContain("prediction-ledger.sqlite3");
    expect(doc).toContain("grafana/dashboards/miner-usage.json");
    expect(doc).toContain("gittensory-miner-attempt-log");
    expect(doc).toContain("https://github.com/JSONbored/gittensory/issues/4875");
    expect(doc).toContain("link out rather than duplicating here");
    expect(doc).toContain("grafana/dashboards/ai-usage.json");
  });

  it("does not claim gittensory-miner init creates the Grafana ledger files", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    expect(doc).toContain("laptop-state.sqlite3");
    expect(doc).toMatch(/init.*does \*\*not\*\* create the Grafana ledger files/i);
    expect(doc).toContain("attempt-log.sqlite3` | First coding-agent attempt");
    expect(doc).toContain("prediction-ledger.sqlite3` | First predicted-gate verdict");
    expect(doc).not.toMatch(/init.*so the SQLite files exist/i);
  });

  it("documents ledger path env vars that appear in env-reference.md", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    const envRef = readFileSync(envReferenceDocPath, "utf8");
    for (const envVar of [
      "GITTENSORY_MINER_CONFIG_DIR",
      "GITTENSORY_MINER_ATTEMPT_LOG_DB",
      "GITTENSORY_MINER_PREDICTION_LEDGER_DB",
    ]) {
      expect(doc).toContain(envVar);
      expect(envRef).toContain(envVar);
    }
  });

  it("links observability.md from coding-agent-driver.md related docs (invariant: entry resolves)", () => {
    const driverDoc = readFileSync(codingAgentDriverDocPath, "utf8");
    expect(driverDoc).toContain("[`observability.md`](observability.md)");
    expect(existsSync(observabilityDocPath)).toBe(true);
  });

  it("documents the planned dashboard path even before miner-usage.json lands", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    expect(doc).toContain("grafana/dashboards/miner-usage.json");
    // Dashboard ships in #5185 — doc must not assume the file exists yet.
    expect(existsSync(minerUsageDashboardPath)).toBe(false);
  });

  it("references existing self-host Grafana provisioning paths as examples", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    expect(doc).toContain("grafana/provisioning/datasources/sqlite.yml");
    expect(doc).toContain("grafana/provisioning/dashboards/provider.yml");
    expect(existsSync(sqliteProvisioningPath)).toBe(true);
    expect(existsSync(dashboardProviderPath)).toBe(true);
  });
});
