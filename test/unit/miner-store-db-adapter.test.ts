import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openLocalStoreAdapter } from "../../packages/loopover-miner/lib/local-store.js";
import { createD1Adapter, nodeSqliteDriver } from "../../packages/loopover-miner/lib/store-db-adapter.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-store-db-adapter-"));
  roots.push(root);
  return root;
}

describe("miner store-db-adapter seam (#7175 part 1)", () => {
  it("nodeSqliteDriver + createD1Adapter implement prepare/bind/all/first/run", async () => {
    const db = new DatabaseSync(":memory:");
    const d1 = createD1Adapter(nodeSqliteDriver(db));
    await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
    expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(1);
    expect((await d1.prepare("SELECT name FROM t WHERE id = ?").bind(1).first<{ name: string }>())?.name).toBe(
      "a",
    );
    expect(await d1.prepare("SELECT * FROM t WHERE id = 99").first()).toBeNull();
    const all = await d1.prepare("SELECT id, name FROM t ORDER BY id").all<{ id: number; name: string }>();
    expect(all.results).toEqual([{ id: 1, name: "a" }]);
    expect(await d1.prepare("SELECT id, name FROM t").raw()).toEqual([[1, "a"]]);
  });

  it("batch is atomic and rolls back on error", async () => {
    const db = new DatabaseSync(":memory:");
    const d1 = createD1Adapter(nodeSqliteDriver(db));
    await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
    await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("dup").run();
    await expect(
      d1.batch([
        d1.prepare("INSERT INTO t (name) VALUES (?)").bind("ok"),
        d1.prepare("INSERT INTO t (name) VALUES (?)").bind("dup"),
      ]),
    ).rejects.toThrow();
    expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(1);
  });

  it("openLocalStoreAdapter returns db + driver + d1 over the same file", async () => {
    const dbPath = join(tempRoot(), "seam.sqlite3");
    const { db, driver, d1 } = openLocalStoreAdapter(dbPath);
    try {
      driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
      driver.query("INSERT INTO t (name) VALUES (?)", ["via-driver"]);
      expect(driver.query("SELECT name FROM t", []).rows).toEqual([{ name: "via-driver" }]);
      expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(1);
      expect(db.prepare("SELECT name FROM t").get()).toEqual({ name: "via-driver" });
    } finally {
      db.close();
    }
  });

  it("dump() returns an ArrayBuffer for D1 surface completeness", async () => {
    const db = new DatabaseSync(":memory:");
    expect(await createD1Adapter(nodeSqliteDriver(db)).dump()).toBeInstanceOf(ArrayBuffer);
  });
});
