#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg, { type PoolClient } from "pg";
import { createPgAdapter } from "../src/selfhost/pg-adapter";
import { createPgQueue } from "../src/selfhost/pg-queue";
import { initPgVectorize } from "../src/selfhost/pg-vectorize";
import { runSelfHostMigrations } from "../src/selfhost/migrate";

interface Options {
  sqlitePath: string;
  postgresUrl: string;
  migrationsDir: string;
  execute: boolean;
  allowNonEmpty: boolean;
  includeVectors: boolean;
  batchSize: number;
}

interface CopyResult {
  table: string;
  rows: number;
  targetRowsBefore: number;
  keyColumns: string[];
}

interface SkipResult {
  table: string;
  reason: string;
}

const INTERNAL_SQLITE_TABLES = new Set(["d1_migrations", "_cf_KV", "__drizzle_migrations", "_selfhost_migrations"]);
const TABLES_ALLOWED_AFTER_SCHEMA_INIT = new Set(["global_agent_controls", "global_contributor_blacklist"]);

function usage(): string {
  return `Usage: npm run selfhost:postgres:migrate -- --sqlite <path> --postgres-url <url> [--execute]

Copies a self-host SQLite database into an empty Postgres backend. The default is a transactionally
rolled-back dry run. Pass --execute to commit the copy.

Options:
  --sqlite <path>          SQLite source file. Defaults to DATABASE_PATH or /data/gittensory.sqlite.
  --postgres-url <url>     Postgres target URL. Defaults to DATABASE_URL.
  --migrations-dir <path>  Migration directory. Defaults to migrations.
  --execute                Commit the copy. Omit for a rollback dry run.
  --allow-non-empty        Allow non-empty target app tables. Off by default.
  --include-vectors        Also copy _selfhost_vectors into pgvector.
  --batch-size <n>         Rows per INSERT batch. Defaults to 250.`;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    sqlitePath: process.env.DATABASE_PATH ?? "/data/gittensory.sqlite",
    postgresUrl: process.env.DATABASE_URL ?? "",
    migrationsDir: process.env.MIGRATIONS_DIR ?? "migrations",
    execute: false,
    allowNonEmpty: false,
    includeVectors: false,
    batchSize: 250,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--sqlite":
        opts.sqlitePath = next();
        break;
      case "--postgres-url":
        opts.postgresUrl = next();
        break;
      case "--migrations-dir":
        opts.migrationsDir = next();
        break;
      case "--execute":
        opts.execute = true;
        break;
      case "--allow-non-empty":
        opts.allowNonEmpty = true;
        break;
      case "--include-vectors":
        opts.includeVectors = true;
        break;
      case "--batch-size": {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--batch-size must be a positive integer");
        opts.batchSize = parsed;
        break;
      }
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.postgresUrl || !/^postgres(?:ql)?:\/\//i.test(opts.postgresUrl)) {
    throw new Error("--postgres-url or DATABASE_URL must be a postgres:// URL");
  }
  if (!existsSync(opts.sqlitePath)) throw new Error(`SQLite source does not exist: ${opts.sqlitePath}`);
  if (!existsSync(opts.migrationsDir)) throw new Error(`Migrations directory does not exist: ${opts.migrationsDir}`);
  return opts;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsupported identifier: ${name}`);
  return `"${name}"`;
}

function sqliteTables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String((row as { name: unknown }).name))
    .filter((table) => !table.startsWith("sqlite_") && !INTERNAL_SQLITE_TABLES.has(table));
}

function sqliteColumns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function sqliteCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get() as { count: number };
  return Number(row.count);
}

function sqliteRows(db: DatabaseSync, table: string, columns: string[], limit: number, offset: number): Record<string, unknown>[] {
  const projection = columns.map(quoteIdent).join(", ");
  return db.prepare(`SELECT ${projection} FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
}

async function pgTables(client: PoolClient): Promise<Set<string>> {
  const res = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return new Set(res.rows.map((row) => row.table_name));
}

async function pgColumns(client: PoolClient, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
  return res.rows.map((row) => row.column_name);
}

async function pgPrimaryKey(client: PoolClient, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1::regclass
        AND i.indisprimary
      ORDER BY k.ord
    `,
    [table],
  );
  return res.rows.map((row) => row.column_name);
}

async function pgCount(client: PoolClient, table: string): Promise<number> {
  const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdent(table)}`);
  return Number(res.rows[0]?.count ?? 0);
}

function valuePlaceholder(index: number, table: string, column: string): string {
  const base = `$${index}`;
  if (table === "_selfhost_vectors" && column === "embedding") return `${base}::vector`;
  if (table === "_selfhost_vectors" && column === "metadata") return `${base}::jsonb`;
  return base;
}

function insertSql(table: string, columns: string[], primaryKey: string[], rowCount: number): string {
  const columnSql = columns.map(quoteIdent).join(", ");
  const valuesSql = Array.from({ length: rowCount }, (_, rowIndex) => {
    const placeholders = columns.map((column, columnIndex) => valuePlaceholder(rowIndex * columns.length + columnIndex + 1, table, column));
    return `(${placeholders.join(", ")})`;
  }).join(", ");
  const conflictColumns = primaryKey.filter((column) => columns.includes(column));
  if (conflictColumns.length === 0) return `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES ${valuesSql}`;
  const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
  const conflictTarget = conflictColumns.map(quoteIdent).join(", ");
  if (updateColumns.length === 0) {
    return `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES ${valuesSql} ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }
  const updates = updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES ${valuesSql} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updates}`;
}

async function copyTable(db: DatabaseSync, client: PoolClient, table: string, columns: string[], primaryKey: string[], batchSize: number): Promise<number> {
  const total = sqliteCount(db, table);
  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = sqliteRows(db, table, columns, batchSize, offset);
    if (rows.length === 0) continue;
    const values = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
    await client.query(insertSql(table, columns, primaryKey, rows.length), values);
  }
  return total;
}

async function countTargetRowsMatchingSourceKeys(
  db: DatabaseSync,
  client: PoolClient,
  table: string,
  keyColumns: string[],
  batchSize: number,
): Promise<number> {
  const total = sqliteCount(db, table);
  let matched = 0;
  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = sqliteRows(db, table, keyColumns, batchSize, offset);
    if (rows.length === 0) continue;
    const values: unknown[] = [];
    for (const row of rows) {
      for (const column of keyColumns) {
        const value = row[column] ?? null;
        if (value === null) throw new Error(`Validation failed for ${table}: source primary key ${column} is null`);
        values.push(value);
      }
    }
    const condition =
      keyColumns.length === 1
        ? `${quoteIdent(keyColumns[0] as string)} IN (${values.map((_, index) => `$${index + 1}`).join(", ")})`
        : `(${keyColumns.map(quoteIdent).join(", ")}) IN (${rows
            .map((_, rowIndex) => {
              const base = rowIndex * keyColumns.length;
              return `(${keyColumns.map((__, columnIndex) => `$${base + columnIndex + 1}`).join(", ")})`;
            })
            .join(", ")})`;
    const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdent(table)} WHERE ${condition}`, values);
    matched += Number(res.rows[0]?.count ?? 0);
  }
  return matched;
}

async function copyAll(opts: Options, db: DatabaseSync, client: PoolClient): Promise<{ copied: CopyResult[]; skipped: SkipResult[] }> {
  const copied: CopyResult[] = [];
  const skipped: SkipResult[] = [];
  let targetTables = await pgTables(client);
  const sourceTables = sqliteTables(db);

  for (const table of sourceTables) {
    if (table === "_selfhost_vectors" && !opts.includeVectors) {
      skipped.push({ table, reason: "vectors are externalized by Qdrant or can be rebuilt; pass --include-vectors for pgvector" });
      continue;
    }
    if (!targetTables.has(table)) throw new Error(`Target Postgres schema is missing source table: ${table}`);
    const targetRowsBefore = await pgCount(client, table);
    if (targetRowsBefore > 0 && !opts.allowNonEmpty && !TABLES_ALLOWED_AFTER_SCHEMA_INIT.has(table)) {
      throw new Error(`Target table ${table} already contains ${targetRowsBefore} row(s); rerun with --allow-non-empty only if this is intentional`);
    }
    const sourceColumns = sqliteColumns(db, table);
    const targetColumns = await pgColumns(client, table);
    const commonColumns = sourceColumns.filter((column) => targetColumns.includes(column));
    if (commonColumns.length === 0) {
      skipped.push({ table, reason: "no common columns" });
      continue;
    }
    const primaryKey = await pgPrimaryKey(client, table);
    const keyColumns = primaryKey.filter((column) => commonColumns.includes(column));
    const rows = await copyTable(db, client, table, commonColumns, primaryKey, opts.batchSize);
    copied.push({ table, rows, targetRowsBefore, keyColumns });
  }

  if (targetTables.has("_selfhost_jobs")) {
    await client.query(
      "SELECT setval(pg_get_serial_sequence('_selfhost_jobs', 'id'), COALESCE((SELECT MAX(id) FROM _selfhost_jobs), 1), (SELECT COUNT(*) > 0 FROM _selfhost_jobs))",
    );
  }

  // Re-run queue init after copying so migrated processing rows are recovered and derived job metadata is current.
  const queue = createPgQueue(client as unknown as pg.Pool, async () => undefined);
  await queue.init();
  await queue.stop();
  targetTables = await pgTables(client);

  for (const result of copied) {
    if (!targetTables.has(result.table)) continue;
    const targetCount = await pgCount(client, result.table);
    if (result.table === "_selfhost_job_stats" || result.targetRowsBefore > 0) {
      if (targetCount < result.targetRowsBefore) {
        throw new Error(`Validation failed for ${result.table}: expected to preserve at least ${result.targetRowsBefore} existing row(s), target has ${targetCount}`);
      }
      if (result.rows > 0 && result.keyColumns.length > 0) {
        const matched = await countTargetRowsMatchingSourceKeys(db, client, result.table, result.keyColumns, opts.batchSize);
        if (matched !== result.rows) {
          throw new Error(`Validation failed for ${result.table}: copied ${result.rows} source row(s), target has ${matched} matching source key(s)`);
        }
        continue;
      }
      const minimumExpectedRows = result.targetRowsBefore + result.rows;
      if (targetCount < minimumExpectedRows) {
        throw new Error(`Validation failed for ${result.table}: expected at least ${minimumExpectedRows} row(s), target has ${targetCount}`);
      }
      continue;
    }
    if (targetCount !== result.rows) {
      throw new Error(`Validation failed for ${result.table}: copied ${result.rows} row(s), target has ${targetCount}`);
    }
  }
  return { copied, skipped };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sqlite = new DatabaseSync(opts.sqlitePath, { readOnly: true });
  sqlite.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");

  const pool = new pg.Pool({ connectionString: opts.postgresUrl, max: 1 });
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const db = createPgAdapter(client as unknown as pg.Pool);
    const migrationsApplied = await runSelfHostMigrations(db, opts.migrationsDir);
    const queue = createPgQueue(client as unknown as pg.Pool, async () => undefined);
    await queue.init();
    await queue.stop();
    if (opts.includeVectors) await initPgVectorize(client as unknown as pg.Pool);

    const { copied, skipped } = await copyAll(opts, sqlite, client);
    if (opts.execute) {
      await client.query("COMMIT");
      finished = true;
    } else {
      await client.query("ROLLBACK");
      finished = true;
    }

    console.log(
      JSON.stringify(
        {
          mode: opts.execute ? "executed" : "dry_run_rolled_back",
          migrationsApplied,
          copied,
          skipped,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
