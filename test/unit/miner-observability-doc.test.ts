import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const observabilityDocPath = join(repoRoot, "packages/gittensory-miner/docs/observability.md");
const codingAgentDriverDocPath = join(repoRoot, "packages/gittensory-miner/docs/coding-agent-driver.md");
const minerUsageDashboardPath = join(repoRoot, "grafana/dashboards/miner-usage.json");

describe("miner observability docs (#5190)", () => {
  it("ships observability.md with concrete Grafana + SQLite setup steps", () => {
    const doc = readFileSync(observabilityDocPath, "utf8");
    expect(doc).toContain("# Observing your miner");
    expect(doc).toContain("frser-sqlite-datasource");
    expect(doc).toContain("attempt-log.sqlite3");
    expect(doc).toContain("prediction-ledger.sqlite3");
    expect(doc).toContain("miner-usage.json");
    expect(doc).toContain("gittensory-miner-attempt-log");
    expect(doc).toContain("4875");
    expect(doc).toContain("link out rather than duplicating here");
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
});
