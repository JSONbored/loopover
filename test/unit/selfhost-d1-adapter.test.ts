import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";

function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  return createD1Adapter(nodeSqliteDriver(db as never));
}

describe("createD1Adapter (#980 self-host D1-over-SQLite)", () => {
  it("implements the D1 surface faithfully: prepare/bind/all/first/raw on reads", async () => {
    const d1 = makeD1();
    await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
    await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("b").run();

    expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(2);
    expect((await d1.prepare("SELECT name FROM t WHERE id = ?").bind(1).first<{ name: string }>())?.name).toBe("a");
    expect(await d1.prepare("SELECT name FROM t WHERE id = ?").bind(1).first("name")).toBe("a"); // colName form
    expect(await d1.prepare("SELECT * FROM t WHERE id = 99").first()).toBeNull(); // no row → null

    const all = await d1.prepare("SELECT id, name FROM t ORDER BY id").all<{ id: number; name: string }>();
    expect(all.results).toEqual([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    const raw = await d1.prepare("SELECT id, name FROM t ORDER BY id").raw();
    expect(raw).toEqual([[1, "a"], [2, "b"]]); // raw() = arrays of column values
  });

  it("run() reports changes/last_row_id; batch is atomic", async () => {
    const d1 = makeD1();
    await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const r = await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("x").run();
    expect(r.meta.changes).toBe(1);
    expect(r.meta.last_row_id).toBe(1);

    await d1.batch([
      d1.prepare("INSERT INTO t (name) VALUES (?)").bind("y"),
      d1.prepare("INSERT INTO t (name) VALUES (?)").bind("z"),
    ]);
    expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(3);
  });

  it("batch rolls back entirely on an error (atomicity)", async () => {
    const d1 = makeD1();
    await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
    await d1.prepare("INSERT INTO t (name) VALUES (?)").bind("dup").run();
    await expect(
      d1.batch([
        d1.prepare("INSERT INTO t (name) VALUES (?)").bind("ok"),
        d1.prepare("INSERT INTO t (name) VALUES (?)").bind("dup"), // UNIQUE violation
      ]),
    ).rejects.toThrow();
    expect((await d1.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(1); // "ok" rolled back
  });

  it("dump() returns an ArrayBuffer (D1 surface completeness)", async () => {
    expect(await makeD1().dump()).toBeInstanceOf(ArrayBuffer);
  });

  it("first(colName) returns the named column value", async () => {
    const d1 = makeD1();
    await d1.exec("CREATE TABLE t (id INTEGER, x TEXT)");
    await d1.prepare("INSERT INTO t (id, x) VALUES (1, 'val')").run();
    expect(await d1.prepare("SELECT x FROM t").first("x")).toBe("val");
    expect(await d1.prepare("SELECT x FROM t WHERE id=99").first("x")).toBeNull(); // no row → null
  });
});
