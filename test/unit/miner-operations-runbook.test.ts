import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Touch local-store so a scoped CI shard that only selects this file still emits non-empty lcov
// under --coverage.all=false (#4942 / PR #8002 empty-shard failure mode).
import { openLocalStoreDb } from "../../packages/loopover-miner/lib/local-store.ts";

const repoRoot = process.cwd();
const runbookPath = join(repoRoot, "packages/loopover-miner/docs/operations-runbook.md");
const codingAgentDriverDocPath = join(repoRoot, "packages/loopover-miner/docs/coding-agent-driver.md");
const deploymentDocPath = join(repoRoot, "packages/loopover-miner/DEPLOYMENT.md");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    expect(doc).toContain("ams-shared-store-concurrency-model.md");
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

  it("opens a local store so coverage.include is hit when this file is the only shard selection", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-runbook-coverage-"));
    roots.push(root);
    const db = openLocalStoreDb(join(root, "runbook.sqlite3"));
    db.exec("CREATE TABLE runbook_smoke (id INTEGER PRIMARY KEY)");
    db.close();
  });
});
