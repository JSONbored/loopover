import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectColumnCollisions, extractSchemaEvents, splitSqlStatements } from "../../src/db/migration-column-extraction";

describe("splitSqlStatements (#2551)", () => {
  it("splits on top-level semicolons", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("ignores semicolons inside single/double/backtick-quoted strings", () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`);")).toEqual(["INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`);"]);
  });

  it("ignores semicolons inside line and block comments", () => {
    const sql = "-- a comment; with a fake terminator\nCREATE TABLE t (a INT); /* another; one */ CREATE TABLE u (b INT);";
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE TABLE t (a INT);");
    expect(statements[1]).toContain("CREATE TABLE u (b INT);");
  });

  it("includes a trailing statement with no terminating semicolon", () => {
    expect(splitSqlStatements("CREATE TABLE t (a INT)")).toEqual(["CREATE TABLE t (a INT)"]);
  });

  it("returns [] for empty/whitespace-only input", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("   \n  ")).toEqual([]);
  });

  it("treats a doubled quote as an escaped quote, not the end of the string", () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('it''s; still one statement');")).toEqual(["INSERT INTO t VALUES ('it''s; still one statement');"]);
  });

  it("treats a lone semicolon (whitespace-only content before it) as its own no-op statement", () => {
    expect(splitSqlStatements("CREATE TABLE t (a INT); ;CREATE TABLE u (b INT);")).toEqual(["CREATE TABLE t (a INT);", ";", "CREATE TABLE u (b INT);"]);
  });
});

describe("extractSchemaEvents (#2551)", () => {
  it("extracts every column from a CREATE TABLE column list", () => {
    const events = extractSchemaEvents("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);");
    expect(events).toEqual([
      { type: "define_column", table: "widgets", column: "id" },
      { type: "define_column", table: "widgets", column: "name" },
      { type: "define_column", table: "widgets", column: "created_at" },
    ]);
  });

  it("lowercases table/column names so case differences never mask a real collision", () => {
    expect(extractSchemaEvents("CREATE TABLE Widgets (Name TEXT);")).toEqual([{ type: "define_column", table: "widgets", column: "name" }]);
  });

  it("handles CREATE TABLE IF NOT EXISTS", () => {
    expect(extractSchemaEvents("CREATE TABLE IF NOT EXISTS widgets (id INTEGER);")).toEqual([{ type: "define_column", table: "widgets", column: "id" }]);
  });

  it("excludes table-level PRIMARY KEY/FOREIGN KEY/UNIQUE/CHECK/CONSTRAINT clauses", () => {
    const events = extractSchemaEvents(
      "CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b), FOREIGN KEY (a) REFERENCES other(id), UNIQUE(a), CHECK (a > 0), CONSTRAINT named_check CHECK (b > 0));",
    );
    expect(events).toEqual([
      { type: "define_column", table: "t", column: "a" },
      { type: "define_column", table: "t", column: "b" },
    ]);
  });

  it("does not split a column definition at a comma nested inside FOREIGN KEY(...) REFERENCES x(...)", () => {
    const events = extractSchemaEvents("CREATE TABLE t (a INTEGER, FOREIGN KEY(a) REFERENCES other(id, name));");
    expect(events).toEqual([{ type: "define_column", table: "t", column: "a" }]);
  });

  it("does not split a column definition at a comma inside an inline trailing comment", () => {
    // Regression: migrations/0060_orb_fleet_collector.sql has columns with trailing `-- ..., ...` comments
    // that previously fooled the top-level comma splitter into treating comment text as a new column.
    const sql = ["CREATE TABLE t (", "  a TEXT NOT NULL, -- one, two, three", "  b TEXT", ");"].join("\n");
    expect(extractSchemaEvents(sql)).toEqual([
      { type: "define_column", table: "t", column: "a" },
      { type: "define_column", table: "t", column: "b" },
    ]);
  });

  it("ignores a leading full-line comment before the actual statement (DROP TABLE)", () => {
    // Regression: a `^`-anchored match against a statement with LEADING comment text (produced when a
    // comment block precedes a statement with no semicolon of its own) previously failed to match.
    const sql = "-- some explanatory comment\n-- spanning two lines\nDROP TABLE IF EXISTS widgets;";
    expect(extractSchemaEvents(sql)).toEqual([{ type: "drop_table", table: "widgets" }]);
  });

  it("extracts a single ADD COLUMN", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets ADD COLUMN color TEXT;")).toEqual([{ type: "define_column", table: "widgets", column: "color" }]);
  });

  it("extracts DROP TABLE (with or without IF EXISTS)", () => {
    expect(extractSchemaEvents("DROP TABLE widgets;")).toEqual([{ type: "drop_table", table: "widgets" }]);
    expect(extractSchemaEvents("DROP TABLE IF EXISTS widgets;")).toEqual([{ type: "drop_table", table: "widgets" }]);
  });

  it("extracts DROP COLUMN as a remove_column event", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets DROP COLUMN color;")).toEqual([{ type: "remove_column", table: "widgets", column: "color" }]);
  });

  it("extracts RENAME COLUMN as a remove_column + define_column pair", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets RENAME COLUMN color TO hue;")).toEqual([
      { type: "remove_column", table: "widgets", column: "color" },
      { type: "define_column", table: "widgets", column: "hue" },
    ]);
  });

  it("extracts ALTER TABLE … RENAME TO as a single rename_table event, disambiguated from column rename (#9647)", () => {
    // The exact rebuild-and-rename statement from migrations/0201_ledger_anchor_bittensor.sql.
    expect(extractSchemaEvents("ALTER TABLE decision_ledger_anchors_new RENAME TO decision_ledger_anchors;")).toEqual([
      { type: "rename_table", from: "decision_ledger_anchors_new", to: "decision_ledger_anchors" },
    ]);
    // The column-rename forms (with and without the COLUMN keyword) must NOT be misparsed as a table rename —
    // they still produce the remove+define pair.
    expect(extractSchemaEvents("ALTER TABLE widgets RENAME color TO hue;")).toEqual([
      { type: "remove_column", table: "widgets", column: "color" },
      { type: "define_column", table: "widgets", column: "hue" },
    ]);
    // And a table named like the "to" keyword must not confuse either regex.
    expect(extractSchemaEvents("ALTER TABLE t RENAME TO t2;")).toEqual([{ type: "rename_table", from: "t", to: "t2" }]);
  });

  it("extracts ADD COLUMN's terser SQLite form that omits the COLUMN keyword (#8368)", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets ADD color TEXT;")).toEqual([{ type: "define_column", table: "widgets", column: "color" }]);
  });

  it("extracts DROP COLUMN's terser SQLite form that omits the COLUMN keyword (#8368)", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets DROP color;")).toEqual([{ type: "remove_column", table: "widgets", column: "color" }]);
  });

  it("extracts RENAME COLUMN's terser SQLite form that omits the COLUMN keyword (#8368)", () => {
    expect(extractSchemaEvents("ALTER TABLE widgets RENAME color TO hue;")).toEqual([
      { type: "remove_column", table: "widgets", column: "color" },
      { type: "define_column", table: "widgets", column: "hue" },
    ]);
  });

  it("returns [] for a statement with no schema-shape effect (CREATE INDEX, INSERT)", () => {
    expect(extractSchemaEvents("CREATE INDEX widgets_name_idx ON widgets (name);")).toEqual([]);
    expect(extractSchemaEvents("INSERT INTO widgets (name) VALUES ('x');")).toEqual([]);
  });

  it("does not treat a comma inside a /* block comment */ column list entry as a clause separator", () => {
    const events = extractSchemaEvents("CREATE TABLE t (a INTEGER, /* a note, with a comma */ b INTEGER);");
    expect(events).toEqual([
      { type: "define_column", table: "t", column: "a" },
      { type: "define_column", table: "t", column: "b" },
    ]);
  });

  it("preserves a doubled single-quote escape inside a DEFAULT string literal while stripping comments", () => {
    const events = extractSchemaEvents("CREATE TABLE t (label TEXT NOT NULL DEFAULT 'it''s here' -- trailing, note\n);");
    expect(events).toEqual([{ type: "define_column", table: "t", column: "label" }]);
  });

  it("skips a top-level clause with no leading identifier instead of crashing", () => {
    const events = extractSchemaEvents("CREATE TABLE t (a INTEGER, (1 = 1), b INTEGER);");
    expect(events).toEqual([
      { type: "define_column", table: "t", column: "a" },
      { type: "define_column", table: "t", column: "b" },
    ]);
  });
});

describe("detectColumnCollisions (#2551)", () => {
  it("returns [] when no two files define the same (table, column)", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (a INTEGER);"],
      ["0002_b.sql", "ALTER TABLE t ADD COLUMN b INTEGER;"],
    ];
    expect(detectColumnCollisions(files)).toEqual([]);
  });

  it("flags a genuine collision: two migrations independently add the same column", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER);"],
      ["0002_b.sql", "ALTER TABLE t ADD COLUMN color TEXT;"],
      ["0003_c.sql", "ALTER TABLE t ADD COLUMN color TEXT;"],
    ];
    expect(detectColumnCollisions(files)).toEqual([{ table: "t", column: "color", files: ["0002_b.sql", "0003_c.sql"] }]);
  });

  it("does NOT flag a DROP TABLE + CREATE TABLE recreate as colliding with the table it replaces", () => {
    // Mirrors migrations/0060_orb_fleet_collector.sql's documented SQLite-ALTER-limitation workaround.
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER, old_col TEXT);"],
      ["0002_b.sql", "DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER, new_col TEXT);"],
    ];
    expect(detectColumnCollisions(files)).toEqual([]);
  });

  it("STILL flags a collision after a recreate if a later migration repeats one of the recreated columns", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER);"],
      ["0002_b.sql", "DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER, fresh_col TEXT);"],
      ["0003_c.sql", "ALTER TABLE t ADD COLUMN fresh_col TEXT;"],
    ];
    expect(detectColumnCollisions(files)).toEqual([{ table: "t", column: "fresh_col", files: ["0002_b.sql", "0003_c.sql"] }]);
  });

  it("STILL flags a collision even when a DROP TABLE for that table comes later in the SAME file (#2607 gate finding)", () => {
    // Real migration execution runs statements strictly in order: `CREATE TABLE t (c INT); ALTER TABLE t
    // ADD COLUMN c INT; DROP TABLE t;` already fails at the duplicate ADD COLUMN, so the DROP TABLE is
    // never reached -- it must not retroactively erase the collision that already happened before it.
    const files: Array<[string, string]> = [["0001_x.sql", "CREATE TABLE t (c INTEGER); ALTER TABLE t ADD COLUMN c INTEGER; DROP TABLE t;"]];
    expect(detectColumnCollisions(files)).toEqual([{ table: "t", column: "c", files: ["0001_x.sql"] }]);
  });

  it("does not flag a genuine column rename as a collision with its old or new name", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER, old_name TEXT);"],
      ["0002_b.sql", "ALTER TABLE t RENAME COLUMN old_name TO new_name;"],
    ];
    expect(detectColumnCollisions(files)).toEqual([]);
  });

  it("does not flag a dropped-then-readded column as a collision", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER, temp_col TEXT);"],
      ["0002_b.sql", "ALTER TABLE t DROP COLUMN temp_col;"],
      ["0003_c.sql", "ALTER TABLE t ADD COLUMN temp_col TEXT;"],
    ];
    expect(detectColumnCollisions(files)).toEqual([]);
  });

  it("REGRESSION: re-keys columns across a rebuild-and-rename so a later duplicate is still caught (#9647)", () => {
    // The standard SQLite rebuild-and-rename (as migrations/0201 does): a new table is built with `backend`,
    // then RENAMEd over the old one. Before #9647 the detector tracked the column under the *_new name and
    // went blind — a later ADD COLUMN backend on the real table read as a fresh, non-colliding definition.
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (id INTEGER, backend TEXT);"],
      ["0002_b.sql", "CREATE TABLE t_new (id INTEGER, backend TEXT); ALTER TABLE t_new RENAME TO t;"],
      ["0003_c.sql", "ALTER TABLE t ADD COLUMN backend TEXT;"],
    ];
    // Exactly one collision on t.backend — the re-keyed column from 0002's renamed table collides with 0003's.
    expect(detectColumnCollisions(files)).toEqual([{ table: "t", column: "backend", files: ["0002_b.sql", "0003_c.sql"] }]);
  });

  it("does not flag the renamed table's columns against the now-vacated old name (#9647)", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t_new (id INTEGER, c TEXT); ALTER TABLE t_new RENAME TO t;"],
      // A brand-new table reusing the OLD (vacated) name must not collide with the columns that moved off it.
      ["0002_b.sql", "CREATE TABLE t_new (id INTEGER, c TEXT);"],
    ];
    expect(detectColumnCollisions(files)).toEqual([]);
  });

  it("returns [] for an empty file list", () => {
    expect(detectColumnCollisions([])).toEqual([]);
  });

  it("sorts multiple simultaneous collisions by table then column", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE z (x INTEGER); CREATE TABLE a (y INTEGER);"],
      ["0002_b.sql", "ALTER TABLE z ADD COLUMN x INTEGER; ALTER TABLE a ADD COLUMN y INTEGER;"],
    ];
    expect(detectColumnCollisions(files).map((c) => `${c.table}.${c.column}`)).toEqual(["a.y", "z.x"]);
  });

  it("sorts two collisions on the SAME table by column name", () => {
    const files: Array<[string, string]> = [
      ["0001_a.sql", "CREATE TABLE t (z_col INTEGER, a_col INTEGER);"],
      ["0002_b.sql", "ALTER TABLE t ADD COLUMN z_col INTEGER; ALTER TABLE t ADD COLUMN a_col INTEGER;"],
    ];
    expect(detectColumnCollisions(files).map((c) => `${c.table}.${c.column}`)).toEqual(["t.a_col", "t.z_col"]);
  });

  it("has zero false positives against the repo's real, already-consistent migrations/ directory", () => {
    const files = readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const contents = files.map((f) => [f, readFileSync(`migrations/${f}`, "utf8")] as const);
    expect(detectColumnCollisions(contents)).toEqual([]);
  });
});
