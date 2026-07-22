import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Import .ts so CI's build:miner-before-coverage layout still attributes hits to coverage.include
// (a sibling .js would otherwise steal the resolve and leave shard lcov empty under --coverage.all=false).
import { openLocalStoreDb, resolveLocalStoreDbPath } from "../../packages/loopover-miner/lib/local-store.ts";

// #4942: doc-surface assertions for the shared-store concurrency model. Also touches local-store so a
// scoped CI shard that only picks up this file still emits a non-empty coverage/lcov.info.

const repoRoot = process.cwd();
const concurrencyModelDocPath = join(repoRoot, "packages/loopover-miner/docs/ams-shared-store-concurrency-model.md");
const runbookPath = join(repoRoot, "packages/loopover-miner/docs/operations-runbook.md");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ams-shared-store-concurrency-model.md (#4942)", () => {
  it("documents guarantees, non-guarantees, and the SqliteDriver / pg-adapter seam", () => {
    expect(existsSync(concurrencyModelDocPath)).toBe(true);
    const doc = readFileSync(concurrencyModelDocPath, "utf8");
    expect(doc).toContain("# AMS shared-store concurrency model");
    expect(doc).toContain("BEGIN IMMEDIATE");
    expect(doc).toContain("READ COMMITTED");
    expect(doc).toContain("createPgAdapter");
    expect(doc).toContain("SqliteDriver");
    expect(doc).toContain("What is not guaranteed");
    expect(doc).toContain("installation-concurrency-admission");
    expect(doc).toContain("map-with-concurrency");
  });

  it("is linked from the operator runbook", () => {
    const runbook = readFileSync(runbookPath, "utf8");
    expect(runbook).toContain("ams-shared-store-concurrency-model.md");
  });

  it("exercises openLocalStoreDb so this shard produces coverage under --coverage.all=false", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-shared-store-doc-"));
    roots.push(root);
    const dbPath = join(root, "smoke.sqlite3");
    expect(resolveLocalStoreDbPath("smoke.sqlite3", "LOOPOVER_MINER_MISSING_ENV", {})).toContain("loopover-miner");
    const db = openLocalStoreDb(dbPath);
    db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY)");
    db.close();
  });
});
