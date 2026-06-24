// SQLite → Postgres SQL dialect translation for the self-host Postgres backend (#977). gittensory's core and
// drizzle-orm/d1 emit SQLite-dialect SQL; this translates the bounded set of SQLite-isms the codebase uses
// (placeholders + a handful of scalar functions + INSERT OR REPLACE/IGNORE) so the SAME queries run on
// Postgres. The timestamp columns are TEXT (ISO strings written by the app), so the datetime/CURRENT_TIMESTAMP
// translations return TEXT in SQLite's format to preserve the existing text-comparison semantics. Validated
// against a real Postgres (all 56 migrations + the runtime query paths).

// INSERT OR REPLACE needs an explicit conflict target on Postgres; map the (few) tables that use it to their PK.
const REPLACE_CONFLICT_KEYS: Record<string, string[]> = {
  system_flags: ["key"],
  tunables_overrides: ["project"],
  tunables_overrides_shadow: ["project"],
  orb_export_cursor: ["instance_hash"],
  orb_signals: ["instance_id", "repo_hash", "pr_hash"],
};

/** Replace `?` placeholders with `$1,$2,…`, skipping any `?` inside single-quoted string literals. */
export function toNumberedPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === "?" && !inString) {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Translate the SQLite scalar functions the codebase uses to Postgres equivalents. */
export function translateFunctions(sql: string): string {
  return (
    sql
      // ISO-now (the DEFAULT on TEXT timestamp columns + nowIso parity)
      .replace(/strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi, `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
      // week / month buckets (stats)
      .replace(/strftime\(\s*'%Y-W%W'\s*,\s*([^)]+?)\s*\)/gi, `to_char(($1)::timestamptz, 'YYYY"-W"WW')`)
      .replace(/strftime\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, `to_char(($1)::timestamptz, 'YYYY-MM')`)
      // datetime('now', <modifier>) → TEXT in SQLite's 'YYYY-MM-DD HH:MM:SS' format (TEXT columns compared)
      .replace(/datetime\(\s*'now'\s*,\s*([^)]+?)\s*\)/gi, `to_char(now() + ($1)::interval, 'YYYY-MM-DD HH24:MI:SS')`)
      .replace(/datetime\(\s*'now'\s*\)/gi, `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`)
      // CURRENT_TIMESTAMP → SQLite's TEXT format (the columns are TEXT)
      .replace(/CURRENT_TIMESTAMP/gi, `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`)
      // json_extract(col, '$.key') → (col::jsonb ->> 'key')  (single-level paths — all the codebase uses)
      .replace(/json_extract\(\s*([^,]+?)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi, `(($1)::jsonb ->> '$2')`)
  );
}

/** Translate INSERT OR REPLACE / INSERT OR IGNORE to Postgres ON CONFLICT. */
export function translateInsertOr(sql: string): string {
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    return `${sql.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO/i, "$1INSERT INTO")} ON CONFLICT DO NOTHING`;
  }
  const m = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)/i.exec(sql);
  if (m) {
    const table = m[1] as string;
    const cols = (m[2] as string).split(",").map((c) => c.trim());
    const pk = REPLACE_CONFLICT_KEYS[table];
    if (!pk) throw new Error(`pg_dialect: INSERT OR REPLACE into '${table}' has no known conflict key`);
    const updates = cols
      .filter((c) => !pk.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(", ");
    const base = sql.replace(/^(\s*)INSERT\s+OR\s+REPLACE\s+INTO/i, "$1INSERT INTO");
    return `${base} ON CONFLICT (${pk.join(", ")}) DO UPDATE SET ${updates}`;
  }
  return sql;
}

/** Strip table qualifiers from an ON CONFLICT target list. drizzle-orm/d1 emits the conflict target as
 *  `ON CONFLICT ("table"."col")` — valid in SQLite, but Postgres requires an unqualified column list
 *  (`ON CONFLICT ("col")`) and otherwise fails with a syntax error, breaking every Drizzle upsert
 *  (e.g. recordWebhookEvent → webhook ingest) on the Postgres backend. Scoped to the conflict-target
 *  parens so qualified column refs elsewhere (WHERE / SELECT / joins) are left intact. */
export function stripConflictTargetQualifiers(sql: string): string {
  // Capture the keyword + opening paren and the closing paren so the original casing/spacing is preserved
  // (drizzle emits lowercase `on conflict`); only the inner target list is rewritten.
  return sql.replace(
    /(\bON\s+CONFLICT\s*\()([^)]*)(\))/gi,
    (_full, open: string, target: string, close: string) => `${open}${target.replace(/"[^"]+"\s*\.\s*("[^"]+")/g, "$1")}${close}`,
  );
}

/** Translate a runtime query (SQLite → Postgres). */
export function translateSql(sql: string): string {
  return toNumberedPlaceholders(stripConflictTargetQualifiers(translateFunctions(translateInsertOr(sql))));
}

/** Migrations are applied as whole multi-statement files via exec(), so the statement-anchored
 *  translateInsertOr() can't reach an `INSERT OR IGNORE` embedded mid-file (e.g. the global_agent_controls
 *  seed in 0059). Rewrite each such statement to Postgres `INSERT … ON CONFLICT DO NOTHING`. Only IGNORE
 *  seeds exist in migrations; an INSERT OR REPLACE statement would need a known conflict key, so it is left
 *  untouched (and would surface as a clear Postgres error) rather than guessed at. */
export function translateMigrationInserts(sql: string): string {
  return sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO\b([^;]*);/gi, "INSERT INTO$1 ON CONFLICT DO NOTHING;");
}

/** Translate a DDL statement (migrations). Column types (TEXT/INTEGER/REAL) are PG-native; the SQLite
 *  default expressions need translating, as does any `INSERT OR IGNORE` seed. No `?` placeholders in DDL. */
export function translateDdl(sql: string): string {
  return translateFunctions(translateMigrationInserts(sql));
}
