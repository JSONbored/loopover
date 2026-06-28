// Apply gittensory's D1 migrations to the self-host SQLite database at startup. The same `migrations/*.sql`
// files Cloudflare applies via `wrangler d1 migrations apply` — they're plain SQLite DDL, so they run as-is
// through the D1 adapter's exec(). Tracked in a `_selfhost_migrations` table so a restart re-applies only the
// new ones (idempotent), mirroring wrangler's migration ledger.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../utils/json";

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let triggerBody = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    const partial = sql.slice(start, i + 1);
    if (/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b[\s\S]*\bBEGIN\b/i.test(partial)) {
      triggerBody = true;
    }

    if (char === ";" && (!triggerBody || /\bEND\s*;\s*$/i.test(partial))) {
      const statement = sql.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
      triggerBody = false;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function runSelfHostMigrations(db: D1Database, dir: string): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS _selfhost_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const existing = await db.prepare("SELECT name FROM _selfhost_migrations").all<{ name: string }>();
  const applied = new Set(existing.results.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    for (const statement of splitSqlStatements(sql)) {
      try {
        await db.exec(statement);
      } catch (error) {
        // Idempotency (#migrate-drift): tolerate duplicate DDL per statement so a drifted multi-step migration
        // still executes the remaining schema changes before the file is recorded as applied.
        if (!/duplicate column|already exists/i.test(errorMessage(error)))
          throw error;
      }
    }
    await db.prepare("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)").bind(file, new Date().toISOString()).run();
    count += 1;
  }
  return count;
}
