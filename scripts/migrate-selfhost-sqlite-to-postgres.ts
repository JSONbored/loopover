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
  commonColumns: string[];
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
  --allow-non-empty        Allow non-empty target tables only when overlapping primary keys are identical.
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

async function prunePgSchemaInitSeed(client: PoolClient, table: string, columns: string[]): Promise<number> {
  if (table === "global_agent_controls") {
    const lastFanoutPredicate = columns.includes("last_regate_fanout_at") ? "AND last_regate_fanout_at IS NULL" : "";
    const res = await client.query(
      `
        DELETE FROM global_agent_controls
        WHERE id = 'singleton'
          AND frozen = 0
          AND updated_by IS NULL
          ${lastFanoutPredicate}
      `,
    );
    return res.rowCount ?? 0;
  }
  if (table === "global_contributor_blacklist") {
    const res = await client.query(
      `
        DELETE FROM global_contributor_blacklist
        WHERE id = 'singleton'
          AND contributor_blacklist_json = '[]'
          AND updated_by IS NULL
      `,
    );
    return res.rowCount ?? 0;
  }
  return 0;
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

async function resetPgSequences(client: PoolClient, tables: Set<string>): Promise<void> {
  const tableNames = [...tables];
  if (tableNames.length === 0) return;
  const res = await client.query<{ table_name: string; column_name: string; sequence_name: string }>(
    `
      SELECT
        c.table_name,
        c.column_name,
        pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS sequence_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = ANY($1::text[])
        AND pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) IS NOT NULL
      ORDER BY c.table_name, c.ordinal_position
    `,
    [tableNames],
  );
  for (const row of res.rows) {
    await client.query(
      `
        SELECT setval(
          $1::regclass,
          COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${quoteIdent(row.table_name)}), 1),
          (SELECT COUNT(${quoteIdent(row.column_name)}) > 0 FROM ${quoteIdent(row.table_name)})
        )
      `,
      [row.sequence_name],
    );
  }
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
  const conflictTarget = conflictColumns.map(quoteIdent).join(", ");
  // Conflict compatibility is checked before copy; never overwrite an existing target row implicitly.
  return `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES ${valuesSql} ON CONFLICT (${conflictTarget}) DO NOTHING`;
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

async function countTargetRowsMatchingSourceRows(
  db: DatabaseSync,
  client: PoolClient,
  table: string,
  columns: string[],
  batchSize: number,
): Promise<number> {
  const total = sqliteCount(db, table);
  let matched = 0;
  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = sqliteRows(db, table, columns, batchSize, offset);
    if (rows.length === 0) continue;
    const values: unknown[] = [];
    for (const row of rows) {
      for (const column of columns) values.push(row[column] ?? null);
    }
    const condition = rows
      .map((_, rowIndex) => {
        const base = rowIndex * columns.length;
        const predicates = columns.map((column, columnIndex) => `${quoteIdent(column)} IS NOT DISTINCT FROM $${base + columnIndex + 1}`);
        return `(${predicates.join(" AND ")})`;
      })
      .join(" OR ");
    const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdent(table)} WHERE ${condition}`, values);
    matched += Number(res.rows[0]?.count ?? 0);
  }
  return matched;
}

async function countConflictingTargetRowsForSourceKeys(
  db: DatabaseSync,
  client: PoolClient,
  table: string,
  keyColumns: string[],
  compareColumns: string[],
  batchSize: number,
): Promise<number> {
  const total = sqliteCount(db, table);
  let conflicts = 0;
  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = sqliteRows(db, table, compareColumns, batchSize, offset);
    if (rows.length === 0) continue;
    const values: unknown[] = [];
    const condition = rows
      .map((row) => {
        const parameterByColumn = new Map<string, number>();
        for (const column of compareColumns) {
          values.push(row[column] ?? null);
          parameterByColumn.set(column, values.length);
        }
        const keyPredicates = keyColumns.map((column) => `${quoteIdent(column)} IS NOT DISTINCT FROM $${parameterByColumn.get(column)}`);
        const differencePredicates = compareColumns.map((column) => `${quoteIdent(column)} IS DISTINCT FROM $${parameterByColumn.get(column)}`);
        return `((${keyPredicates.join(" AND ")}) AND (${differencePredicates.join(" OR ")}))`;
      })
      .join(" OR ");
    const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdent(table)} WHERE ${condition}`, values);
    conflicts += Number(res.rows[0]?.count ?? 0);
  }
  return conflicts;
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
    const sourceColumns = sqliteColumns(db, table);
    const targetColumns = await pgColumns(client, table);
    if (TABLES_ALLOWED_AFTER_SCHEMA_INIT.has(table)) {
      await prunePgSchemaInitSeed(client, table, targetColumns);
    }
    const targetRowsBefore = await pgCount(client, table);
    if (targetRowsBefore > 0 && !opts.allowNonEmpty) {
      throw new Error(`Target table ${table} already contains ${targetRowsBefore} row(s); rerun with --allow-non-empty only if this is intentional`);
    }
    const commonColumns = sourceColumns.filter((column) => targetColumns.includes(column));
    if (commonColumns.length === 0) {
      skipped.push({ table, reason: "no common columns" });
      continue;
    }
    const primaryKey = await pgPrimaryKey(client, table);
    const keyColumns = primaryKey.filter((column) => commonColumns.includes(column));
    if (targetRowsBefore > 0 && keyColumns.length === 0) {
      throw new Error(`Target table ${table} already contains ${targetRowsBefore} row(s) but has no comparable copied primary key; --allow-non-empty cannot safely merge it`);
    }
    if (targetRowsBefore > 0 && keyColumns.length > 0) {
      const conflicts = await countConflictingTargetRowsForSourceKeys(db, client, table, keyColumns, commonColumns, opts.batchSize);
      if (conflicts > 0) {
        throw new Error(`Target table ${table} already contains ${conflicts} conflicting row(s); --allow-non-empty only permits identical overlapping primary keys`);
      }
    }
    const rows = await copyTable(db, client, table, commonColumns, primaryKey, opts.batchSize);
    copied.push({ table, rows, targetRowsBefore, keyColumns, commonColumns });
  }

  await resetPgSequences(client, new Set(copied.map((result) => result.table)));

  // Re-run queue init after copying so migrated processing rows are recovered and derived job metadata is current.
  const queue = createPgQueue(client as unknown as pg.Pool, async () => undefined);
  await queue.init();
  await queue.stop();
  await resetPgSequences(client, new Set(copied.map((result) => result.table)));
  targetTables = await pgTables(client);

  for (const result of copied) {
    if (!targetTables.has(result.table)) continue;
    const targetCount = await pgCount(client, result.table);
    if (result.table === "_selfhost_job_stats" || result.targetRowsBefore > 0) {
      if (targetCount < result.targetRowsBefore) {
        throw new Error(`Validation failed for ${result.table}: expected to preserve at least ${result.targetRowsBefore} existing row(s), target has ${targetCount}`);
      }
      const validationColumns = result.keyColumns.length > 0 ? result.keyColumns : result.commonColumns;
      if (result.rows > 0 && validationColumns.length > 0) {
        const matched = await countTargetRowsMatchingSourceRows(db, client, result.table, validationColumns, opts.batchSize);
        const validMatchCount = result.keyColumns.length > 0 ? matched === result.rows : matched >= result.rows;
        if (!validMatchCount) {
          const unit = result.keyColumns.length > 0 ? "source key(s)" : "source row(s)";
          throw new Error(`Validation failed for ${result.table}: copied ${result.rows} source row(s), target has ${matched} matching ${unit}`);
        }
        continue;
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
  let sqliteTransactionOpen = false;
  try {
    // Pin one source snapshot across COUNT + paged reads so a live writer cannot create a mixed copy.
    sqlite.exec("BEGIN DEFERRED TRANSACTION;");
    sqliteTransactionOpen = true;
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
    if (sqliteTransactionOpen) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        // Read-only snapshot cleanup is best-effort; Postgres rollback above is the safety boundary.
      }
    }
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
