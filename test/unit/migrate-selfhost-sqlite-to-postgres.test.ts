import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

// (#8391) Unit coverage for the self-host SQLite → Postgres migration script. Pure helpers are tested
// directly; copyAll uses a stateful mock PoolClient (same convention as selfhost-pg-adapter.test.ts)
// plus a real in-memory node:sqlite source. createPgQueue is stubbed so post-copy queue init is a no-op.

vi.mock("../../src/selfhost/pg-queue", () => ({
  createPgQueue: () => ({
    init: async () => undefined,
    stop: async () => undefined,
  }),
}));

import {
  copyAll,
  insertSql,
  normalizePostgresValue,
  parseArgs,
  quoteIdent,
  valuePlaceholder,
  type Options,
} from "../../scripts/migrate-selfhost-sqlite-to-postgres";

type TableState = {
  columns: string[];
  pk: string[];
  rows: Record<string, unknown>[];
};

type PgState = {
  tables: Map<string, TableState>;
};

function makeStatefulClient(state: PgState): PoolClient & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  async function query(sql: unknown, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const text = String(sql);
    queries.push({ sql: text, params });

    if (text.includes("FROM information_schema.tables")) {
      const rows = [...state.tables.keys()].map((table_name) => ({ table_name }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("FROM information_schema.columns")) {
      const table = String(params[0] ?? "");
      const columns = state.tables.get(table)?.columns ?? [];
      const rows = columns.map((column_name) => ({ column_name }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("indisprimary")) {
      const table = String(params[0] ?? "");
      const pk = state.tables.get(table)?.pk ?? [];
      const rows = pk.map((column_name) => ({ column_name }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("pg_get_serial_sequence") && text.includes("information_schema.columns")) {
      return { rows: [], rowCount: 0 };
    }

    if (text.includes("setval(")) {
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith("DELETE FROM")) {
      return { rows: [], rowCount: 0 };
    }

    const plainCount = text.match(/^SELECT COUNT\(\*\)::text AS count FROM "([A-Za-z0-9_]+)"$/);
    if (plainCount) {
      const table = plainCount[1]!;
      const count = state.tables.get(table)?.rows.length ?? 0;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    if (text.includes("COUNT(*)::text AS count") && text.includes("WHERE")) {
      const tableMatch = text.match(/FROM "([A-Za-z0-9_]+)"/);
      const table = tableMatch?.[1] ?? "";
      const tableState = state.tables.get(table);
      if (text.includes("IS DISTINCT FROM")) {
        // Default: no conflicting overlapping keys.
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      // Match probe (`IS NOT DISTINCT FROM`): count target rows that share any batched key tuple.
      // Params are flattened key columns per source row; return one match per source row when present.
      const keyWidth = Math.max(1, (text.match(/IS NOT DISTINCT FROM/g) ?? []).length / Math.max(1, text.split(" OR ").length));
      const sourceRowCount = Math.floor(params.length / Math.max(keyWidth, 1));
      if (!tableState || sourceRowCount === 0) return { rows: [{ count: "0" }], rowCount: 1 };
      // For unit tests, identical overlapping keys mean each source row matches exactly once.
      let matched = 0;
      for (let rowIndex = 0; rowIndex < sourceRowCount; rowIndex += 1) {
        const keyValues = params.slice(rowIndex * keyWidth, rowIndex * keyWidth + keyWidth);
        const hit = tableState.rows.some((row) => {
          // Prefer PK columns when available; otherwise compare by param position against common columns.
          const columns = tableState.pk.length > 0 ? tableState.pk : tableState.columns.slice(0, keyWidth);
          return columns.every((column, index) => row[column] === keyValues[index]);
        });
        if (hit) matched += 1;
      }
      return { rows: [{ count: String(matched) }], rowCount: 1 };
    }

    const insertMatch = text.match(/^INSERT INTO "([A-Za-z0-9_]+)" \((.+)\) VALUES/);
    if (insertMatch) {
      const table = insertMatch[1]!;
      const columnSql = insertMatch[2]!;
      const columns = [...columnSql.matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1]!);
      const tableState = state.tables.get(table);
      if (!tableState) return { rows: [], rowCount: 0 };
      const rowWidth = columns.length;
      const onConflict = /ON CONFLICT/.test(text);
      let inserted = 0;
      for (let offset = 0; offset < params.length; offset += rowWidth) {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < rowWidth; i += 1) row[columns[i]!] = params[offset + i];
        if (onConflict && tableState.pk.length > 0) {
          const conflict = tableState.rows.some((existing) => tableState.pk.every((column) => existing[column] === row[column]));
          if (conflict) continue;
        }
        tableState.rows.push(row);
        inserted += 1;
      }
      return { rows: [], rowCount: inserted };
    }

    return { rows: [], rowCount: 0 };
  }

  return { query, release() {}, queries } as unknown as PoolClient & { queries: Array<{ sql: string; params: unknown[] }> };
}

function baseOpts(overrides: Partial<Options> = {}): Options {
  return {
    sqlitePath: ":memory:",
    postgresUrl: "postgres://loopover:loopover@127.0.0.1:5432/loopover",
    migrationsDir: "migrations",
    execute: false,
    allowNonEmpty: false,
    includeVectors: false,
    batchSize: 250,
    ...overrides,
  };
}

function openMemorySource(setup: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  setup(db);
  return db;
}

describe("migrate-selfhost-sqlite-to-postgres pure helpers (#8391)", () => {
  it("quoteIdent wraps safe identifiers and rejects injection-shaped names", () => {
    expect(quoteIdent("widgets")).toBe('"widgets"');
    expect(quoteIdent("_selfhost_vectors")).toBe('"_selfhost_vectors"');
    expect(() => quoteIdent('widgets"; DROP TABLE t; --')).toThrow(/Unsupported identifier/);
    expect(() => quoteIdent("1bad")).toThrow(/Unsupported identifier/);
  });

  it("valuePlaceholder casts _selfhost_vectors embedding/metadata and leaves other columns bare", () => {
    expect(valuePlaceholder(1, "_selfhost_vectors", "embedding")).toBe("$1::vector");
    expect(valuePlaceholder(2, "_selfhost_vectors", "metadata")).toBe("$2::jsonb");
    expect(valuePlaceholder(3, "_selfhost_vectors", "id")).toBe("$3");
    expect(valuePlaceholder(1, "widgets", "embedding")).toBe("$1");
  });

  it("normalizePostgresValue replaces NUL bytes in strings and leaves other values alone", () => {
    expect(normalizePostgresValue(12)).toBe(12);
    expect(normalizePostgresValue(null)).toBeNull();
    expect(normalizePostgresValue("clean")).toBe("clean");
    expect(normalizePostgresValue("a\0b")).toBe("a\uFFFDb");
  });

  it("insertSql builds multi-row INSERT and ON CONFLICT DO NOTHING when PK overlaps columns", () => {
    expect(insertSql("widgets", ["id", "name"], [], 2)).toBe(
      'INSERT INTO "widgets" ("id", "name") VALUES ($1, $2), ($3, $4)',
    );
    expect(insertSql("widgets", ["id", "name"], ["id"], 1)).toBe(
      'INSERT INTO "widgets" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO NOTHING',
    );
    expect(insertSql("_selfhost_vectors", ["id", "embedding", "metadata"], ["id"], 1)).toBe(
      'INSERT INTO "_selfhost_vectors" ("id", "embedding", "metadata") VALUES ($1, $2::vector, $3::jsonb) ON CONFLICT ("id") DO NOTHING',
    );
  });
});

describe("parseArgs (#8391)", () => {
  const originalEnv = { ...process.env };
  let scratchRoot = "";

  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "migrate-args-"));
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PATH;
    delete process.env.MIGRATIONS_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(scratchRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function touchSqlite(): string {
    const path = join(scratchRoot, "source.sqlite");
    writeFileSync(path, "");
    return path;
  }

  function touchMigrations(): string {
    const path = join(scratchRoot, "migrations");
    mkdirSync(path);
    return path;
  }

  it("parses flags and validates a postgres URL", () => {
    const sqlitePath = touchSqlite();
    const migrationsDir = touchMigrations();
    const opts = parseArgs([
      "--sqlite",
      sqlitePath,
      "--postgres-url",
      "postgresql://loopover:loopover@127.0.0.1:5432/loopover",
      "--migrations-dir",
      migrationsDir,
      "--execute",
      "--allow-non-empty",
      "--include-vectors",
      "--batch-size",
      "10",
    ]);
    expect(opts).toMatchObject({
      sqlitePath,
      migrationsDir,
      execute: true,
      allowNonEmpty: true,
      includeVectors: true,
      batchSize: 10,
    });
  });

  it("rejects missing/invalid postgres URL, bad batch size, and missing paths", () => {
    const sqlitePath = touchSqlite();
    const migrationsDir = touchMigrations();
    expect(() => parseArgs(["--sqlite", sqlitePath, "--migrations-dir", migrationsDir])).toThrow(/postgres:\/\/ URL/);
    expect(() =>
      parseArgs(["--sqlite", sqlitePath, "--migrations-dir", migrationsDir, "--postgres-url", "http://example.com"]),
    ).toThrow(/postgres:\/\/ URL/);
    expect(() =>
      parseArgs([
        "--sqlite",
        sqlitePath,
        "--migrations-dir",
        migrationsDir,
        "--postgres-url",
        "postgres://x",
        "--batch-size",
        "0",
      ]),
    ).toThrow(/positive integer/);
    expect(() =>
      parseArgs([
        "--sqlite",
        sqlitePath,
        "--migrations-dir",
        migrationsDir,
        "--postgres-url",
        "postgres://x",
        "--batch-size",
        "nope",
      ]),
    ).toThrow(/positive integer/);
    expect(() => parseArgs(["--sqlite", join(scratchRoot, "missing.sqlite"), "--postgres-url", "postgres://x", "--migrations-dir", migrationsDir])).toThrow(
      /SQLite source does not exist/,
    );
    expect(() => parseArgs(["--sqlite", sqlitePath, "--postgres-url", "postgres://x", "--migrations-dir", join(scratchRoot, "missing-migrations")])).toThrow(
      /Migrations directory does not exist/,
    );
    expect(() => parseArgs(["--postgres-url"])).toThrow(/Missing value/);
    expect(() => parseArgs(["--unknown-flag"])).toThrow(/Unknown argument/);
  });

  it("prints usage and exits on --help", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => parseArgs(["--help"])).toThrow(/exit:0/);
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("--execute");
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("copyAll (#8391)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies rows into an empty target, resets sequences, and validates exact counts", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a'), (2, 'b')");
    });
    const state: PgState = {
      tables: new Map([["widgets", { columns: ["id", "name"], pk: ["id"], rows: [] }]]),
    };
    const client = makeStatefulClient(state);
    const result = await copyAll(baseOpts({ batchSize: 1 }), db, client);
    expect(result.copied).toEqual([
      expect.objectContaining({ table: "widgets", rows: 2, targetRowsBefore: 0, keyColumns: ["id"], commonColumns: ["id", "name"] }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(state.tables.get("widgets")?.rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    expect(client.queries.some((entry) => entry.sql.includes("INSERT INTO \"widgets\""))).toBe(true);
    db.close();
  });

  it("skips _selfhost_vectors without --include-vectors and copies them when enabled", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a')");
      source.exec("CREATE TABLE _selfhost_vectors (id TEXT PRIMARY KEY, embedding TEXT, metadata TEXT)");
      source.exec("INSERT INTO _selfhost_vectors (id, embedding, metadata) VALUES ('v1', '[1]', '{}')");
    });

    const skippedState: PgState = {
      tables: new Map([
        ["widgets", { columns: ["id", "name"], pk: ["id"], rows: [] }],
        ["_selfhost_vectors", { columns: ["id", "embedding", "metadata"], pk: ["id"], rows: [] }],
      ]),
    };
    const skippedClient = makeStatefulClient(skippedState);
    const skipped = await copyAll(baseOpts({ includeVectors: false }), db, skippedClient);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({ table: "_selfhost_vectors", reason: expect.stringContaining("--include-vectors") }),
    ]);
    expect(skippedState.tables.get("_selfhost_vectors")?.rows).toEqual([]);

    const includedState: PgState = {
      tables: new Map([
        ["widgets", { columns: ["id", "name"], pk: ["id"], rows: [] }],
        ["_selfhost_vectors", { columns: ["id", "embedding", "metadata"], pk: ["id"], rows: [] }],
      ]),
    };
    const includedClient = makeStatefulClient(includedState);
    const included = await copyAll(baseOpts({ includeVectors: true }), db, includedClient);
    expect(included.copied.map((row) => row.table).sort()).toEqual(["_selfhost_vectors", "widgets"]);
    expect(includedState.tables.get("_selfhost_vectors")?.rows).toHaveLength(1);
    expect(includedClient.queries.some((entry) => entry.sql.includes("$2::vector") && entry.sql.includes("$3::jsonb"))).toBe(true);
    db.close();
  });

  it("throws when the target schema is missing a source table", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY)");
    });
    const client = makeStatefulClient({ tables: new Map() });
    await expect(copyAll(baseOpts(), db, client)).rejects.toThrow(/missing source table: widgets/);
    db.close();
  });

  it("throws when the target already has rows and --allow-non-empty is not set", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a')");
    });
    const client = makeStatefulClient({
      tables: new Map([["widgets", { columns: ["id", "name"], pk: ["id"], rows: [{ id: 9, name: "existing" }] }]]),
    });
    await expect(copyAll(baseOpts({ allowNonEmpty: false }), db, client)).rejects.toThrow(/already contains 1 row/);
    db.close();
  });

  it("allows non-empty targets with identical overlapping keys and rejects conflicting keys", async () => {
    const compatibleDb = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a')");
    });
    const compatibleClient = makeStatefulClient({
      tables: new Map([["widgets", { columns: ["id", "name"], pk: ["id"], rows: [{ id: 1, name: "a" }] }]]),
    });
    const compatible = await copyAll(baseOpts({ allowNonEmpty: true }), compatibleDb, compatibleClient);
    expect(compatible.copied[0]).toMatchObject({ table: "widgets", rows: 1, targetRowsBefore: 1 });
    compatibleDb.close();

    const conflictingDb = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'source')");
    });
    const conflictingClient = makeStatefulClient({
      tables: new Map([["widgets", { columns: ["id", "name"], pk: ["id"], rows: [{ id: 1, name: "target" }] }]]),
    });
    // Force the conflict probe to report a conflict count.
    const originalQuery = conflictingClient.query.bind(conflictingClient);
    conflictingClient.query = (async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("IS DISTINCT FROM")) return { rows: [{ count: "1" }], rowCount: 1 };
      return originalQuery(text, params);
    }) as typeof conflictingClient.query;
    await expect(copyAll(baseOpts({ allowNonEmpty: true }), conflictingDb, conflictingClient)).rejects.toThrow(/conflicting row/);
    conflictingDb.close();
  });

  it("throws when a non-empty target table has no comparable primary key overlap", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (name TEXT)");
      source.exec("INSERT INTO widgets (name) VALUES ('a')");
    });
    const client = makeStatefulClient({
      tables: new Map([["widgets", { columns: ["name"], pk: [], rows: [{ name: "existing" }] }]]),
    });
    await expect(copyAll(baseOpts({ allowNonEmpty: true }), db, client)).rejects.toThrow(/no comparable copied primary key/);
    db.close();
  });

  it("validates post-copy counts: exact match for empty targets and at-least for job_stats / non-empty targets", async () => {
    const exactDb = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a')");
    });
    const exactState: PgState = {
      tables: new Map([["widgets", { columns: ["id", "name"], pk: ["id"], rows: [] }]]),
    };
    const exactClient = makeStatefulClient(exactState);
    const originalExact = exactClient.query.bind(exactClient);
    let inserts = 0;
    exactClient.query = (async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith("INSERT INTO")) {
        inserts += 1;
        // Pretend the insert succeeded but leave the table empty so validation fails.
        return { rows: [], rowCount: 1 };
      }
      if (text.match(/^SELECT COUNT\(\*\)::text AS count FROM "widgets"$/) && inserts > 0) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      return originalExact(text, params);
    }) as typeof exactClient.query;
    await expect(copyAll(baseOpts(), exactDb, exactClient)).rejects.toThrow(/copied 1 row\(s\), target has 0/);
    exactDb.close();

    const statsDb = openMemorySource((source) => {
      source.exec("CREATE TABLE _selfhost_job_stats (id TEXT PRIMARY KEY, value TEXT)");
      source.exec("INSERT INTO _selfhost_job_stats (id, value) VALUES ('a', '1')");
    });
    const statsState: PgState = {
      tables: new Map([["_selfhost_job_stats", { columns: ["id", "value"], pk: ["id"], rows: [{ id: "seed", value: "0" }] }]]),
    };
    const statsClient = makeStatefulClient(statsState);
    const originalStats = statsClient.query.bind(statsClient);
    let afterInsert = false;
    statsClient.query = (async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith("INSERT INTO")) {
        afterInsert = true;
        return { rows: [], rowCount: 1 };
      }
      if (afterInsert && text.match(/^SELECT COUNT\(\*\)::text AS count FROM "_selfhost_job_stats"$/)) {
        // Post-copy path: report fewer rows than targetRowsBefore so the at-least check fails.
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      return originalStats(text, params);
    }) as typeof statsClient.query;
    await expect(copyAll(baseOpts({ allowNonEmpty: true }), statsDb, statsClient)).rejects.toThrow(
      /preserve at least 1 existing row/,
    );
    statsDb.close();
  });

  it("skips tables with no common columns", async () => {
    const db = openMemorySource((source) => {
      source.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      source.exec("INSERT INTO widgets (id, name) VALUES (1, 'a')");
    });
    const client = makeStatefulClient({
      tables: new Map([["widgets", { columns: ["other"], pk: ["other"], rows: [] }]]),
    });
    const result = await copyAll(baseOpts(), db, client);
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([{ table: "widgets", reason: "no common columns" }]);
    db.close();
  });
});
