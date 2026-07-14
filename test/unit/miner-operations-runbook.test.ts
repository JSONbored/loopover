import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const runbookPath = join(repoRoot, "packages/gittensory-miner/docs/operations-runbook.md");
const codingAgentDriverDocPath = join(repoRoot, "packages/gittensory-miner/docs/coding-agent-driver.md");
const deploymentDocPath = join(repoRoot, "packages/gittensory-miner/DEPLOYMENT.md");

describe("miner operations runbook (#4875)", () => {
  it("covers the three operational scenarios from the issue plus the busy_timeout guarantee", () => {
    const doc = readFileSync(runbookPath, "utf8");
    expect(doc).toContain("# loopover-miner — operational runbook");
    expect(doc).toMatch(/ledger corrupted|corrupted_\*_row|corrupted_/i);
    expect(doc).toMatch(/two miners collided|two miners on one state/i);
    expect(doc).toMatch(/migrate.*upgrade|package upgrade/i);
    expect(doc).toContain("PRAGMA busy_timeout");
    expect(doc).toContain("5000");
    expect(doc).toContain("BEGIN IMMEDIATE");
  });

  it("links from coding-agent-driver.md related docs (invariant: entry resolves)", () => {
    const driverDoc = readFileSync(codingAgentDriverDocPath, "utf8");
    expect(driverDoc).toContain("[`operations-runbook.md`](operations-runbook.md)");
    expect(existsSync(runbookPath)).toBe(true);
  });

  it("is linked from DEPLOYMENT.md for operators deploying fleet or laptop mode", () => {
    const deploymentDoc = readFileSync(deploymentDocPath, "utf8");
    expect(deploymentDoc).toContain("docs/operations-runbook.md");
  });
});
