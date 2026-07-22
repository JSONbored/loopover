import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";

import { openClaimLedger } from "../../packages/loopover-miner/lib/claim-ledger.js";
import { openLocalStoreDb } from "../../packages/loopover-miner/lib/local-store.js";
import { createD1Adapter, nodeSqliteDriver } from "../../packages/loopover-miner/lib/store-db-adapter.js";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";

// #4942: correctness load coverage for the shared-store concurrency model.
// Empirically verifies the guarantees documented in
// packages/loopover-miner/docs/ams-shared-store-concurrency-model.md — no lost updates under the
// patterns the model claims are safe (BEGIN IMMEDIATE cap claims; single-statement increments;
// Postgres createPgAdapter concurrent writers). Wall-clock throughput is out of scope.

const repoRoot = process.cwd();
const concurrencyModelDocPath = join(repoRoot, "packages/loopover-miner/docs/ams-shared-store-concurrency-model.md");
const runbookPath = join(repoRoot, "packages/loopover-miner/docs/operations-runbook.md");

const claimWithinCapChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/claim-within-cap-child.mjs",
);

const roots: string[] = [];

function tempRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-shared-store-concurrency-"));
  roots.push(root);
  return { root, dbPath: join(root, "store.sqlite3") };
}

function spawnChild(script: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.includes("READY\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`child exited before READY (${code})`));
    });
  });
}

async function runBarriered<T>(children: ChildProcessWithoutNullStreams[]): Promise<T[]> {
  await Promise.all(children.map((child) => waitForReady(child)));
  for (const child of children) child.stdin.write("go\n");
  return Promise.all(
    children.map(
      (child) =>
        new Promise<T>((resolve, reject) => {
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.once("error", reject);
          child.once("exit", () => {
            const line = stdout
              .split("\n")
              .map((entry) => entry.trim())
              .find((entry) => entry.startsWith("{"));
            if (!line) {
              reject(new Error(`child produced no JSON result: ${stdout}`));
              return;
            }
            resolve(JSON.parse(line) as T);
          });
        }),
    ),
  );
}

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
});

type CapChildResult = {
  ok: boolean;
  result?: { claimed: boolean; activeClaimCount: number; maxConcurrentClaims: number };
  message?: string;
};

describe("claimIssueWithinCap cross-process load (#4942)", () => {
  it("N processes racing cap=1 on distinct issues: exactly one claim wins, no lost/duplicated active rows", async () => {
    const { dbPath } = tempRoot();
    const issues = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const children = issues.map((issue) =>
      spawnChild(claimWithinCapChildScript, [dbPath, "acme/widgets", issue, "1", `note:${issue}`]),
    );
    const results = await runBarriered<CapChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    const winners = results.filter((result) => result.result?.claimed === true);
    const losers = results.filter((result) => result.result?.claimed === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(issues.length - 1);

    const ledger = openClaimLedger(dbPath);
    try {
      const active = ledger.listActiveClaims("acme/widgets");
      expect(active).toHaveLength(1);
      expect(ledger.listClaims({ repoFullName: "acme/widgets", status: "active" })).toHaveLength(1);
      // The sole active issue must be one of the raced issue numbers (whichever process won the IMMEDIATE lock).
      expect(issues.map(Number)).toContain(active[0]?.issueNumber);
    } finally {
      ledger.close();
    }
  });

  it("rejects the claim-within-cap-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [claimWithinCapChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });
});

describe("SqliteDriver / createD1Adapter concurrent increments (#4942)", () => {
  it("N concurrent atomic UPDATE n = n + 1 writers produce exactly N (no lost updates)", async () => {
    const { dbPath } = tempRoot();
    const db = openLocalStoreDb(dbPath);
    const driver = nodeSqliteDriver(db);
    driver.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    driver.query("INSERT INTO counters (id, n) VALUES (?, ?)", ["shared", 0]);

    const adapter = createD1Adapter(driver);
    const workers = 32;
    await Promise.all(
      Array.from({ length: workers }, () =>
        adapter.batch([adapter.prepare("UPDATE counters SET n = n + 1 WHERE id = ?").bind("shared")]),
      ),
    );

    const row = driver.query("SELECT n AS n FROM counters WHERE id = ?", ["shared"]).rows[0] as { n: number };
    expect(row.n).toBe(workers);
    db.close();
  });

  it("naive app-level RMW across separate statements can lose updates (documents the non-guarantee)", async () => {
    // Two sync connections: each reads n, then writes n+1 outside BEGIN IMMEDIATE / without n=n+1.
    // Under SQLite this often still serializes enough to "look fine" for tiny N; we force the race by
    // interleaving read on A, read on B, write on A, write on B — the classic lost-update schedule.
    const { dbPath } = tempRoot();
    const a = openLocalStoreDb(dbPath);
    const b = openLocalStoreDb(dbPath);
    a.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    a.prepare("INSERT INTO counters (id, n) VALUES (?, ?)").run("shared", 0);

    const readA = (a.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    const readB = (b.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    a.prepare("UPDATE counters SET n = ? WHERE id = ?").run(readA + 1, "shared");
    b.prepare("UPDATE counters SET n = ? WHERE id = ?").run(readB + 1, "shared");

    const final = (a.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    expect(final).toBe(1); // both writers computed 0+1; last write wins — one increment lost
    a.close();
    b.close();
  });
});

const PG_URL = process.env.PG_TEST_URL;
const pgSuite = PG_URL ? describe : describe.skip;

pgSuite("Postgres createPgAdapter concurrent increments (#4942)", () => {
  it("N concurrent atomic UPDATE n = n + 1 writers produce exactly N (no lost updates)", async () => {
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
    const pool = new pg.Pool({ connectionString: PG_URL });
    try {
      await pool.query("DROP TABLE IF EXISTS ams_concurrency_counters");
      await pool.query("CREATE TABLE ams_concurrency_counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
      const db = createPgAdapter(pool);
      await db.prepare("INSERT INTO ams_concurrency_counters (id, n) VALUES (?, ?)").bind("shared", 0).run();

      const workers = 32;
      await Promise.all(
        Array.from({ length: workers }, () =>
          db.prepare("UPDATE ams_concurrency_counters SET n = n + 1 WHERE id = ?").bind("shared").run(),
        ),
      );

      const row = await db
        .prepare("SELECT n AS n FROM ams_concurrency_counters WHERE id = ?")
        .bind("shared")
        .first<{ n: number }>();
      expect(row?.n).toBe(workers);
    } finally {
      await pool.end();
    }
  });
});
