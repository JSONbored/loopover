// Apply loopover's D1 migrations to the self-host SQLite database at startup. The same `migrations/*.sql`
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

/** SQL-literal escape for the migration name written into the ledger inside the transactional script. The
 *  names are our own repo filenames (`NNNN_*.sql`), not user input, but the doubling keeps the script correct
 *  for any name rather than relying on that. */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Apply pending self-host migrations.
 *
 * #9027 — each file now runs as ONE transaction, with its ledger row committed inside that same transaction, so
 * a file is all-or-nothing. Before this, statements ran individually and the file was recorded only after the
 * last one succeeded, so a crash mid-file re-ran the WHOLE file on the next boot. That is fine for pure DDL and
 * actively harmful for the several migrations carrying real DML — the table-rebuild `INSERT ... SELECT`
 * pattern, plus UPDATE/DELETE steps — where a re-run either double-inserts or raises a PK conflict which, not
 * matching the tolerated "already exists" shape, throws and bricks boot. With deploys currently ending in
 * SIGKILL under load (#9007), a mid-migration kill is not hypothetical.
 *
 * The pre-existing drift tolerance is preserved, not replaced. A database that already drifted — a column a
 * migration adds is somehow present — must still heal itself rather than fail to boot, and that self-healing
 * only works per-statement. So a file that fails atomically is retried through the original tolerant path.
 * The two orders matter: atomic first means a genuine mid-file crash is the case that gets protected, and the
 * tolerant fallback only runs for a database that was already inconsistent before this boot began.
 */
export async function runSelfHostMigrations(db: D1Database, dir: string): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS _selfhost_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const existing = await db.prepare("SELECT name FROM _selfhost_migrations").all<{ name: string }>();
  const applied = new Set(existing.results.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  // Real Cloudflare D1 has no transactional multi-statement surface; only the two self-host adapters implement
  // this. Absent it, behavior is exactly the pre-#9027 path.
  const execTransaction = (db as unknown as { execTransaction?: (sql: string) => Promise<void> }).execTransaction;
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const statements = splitSqlStatements(sql);
    const ledger = `INSERT INTO _selfhost_migrations (name, applied_at) VALUES (${sqlQuote(file)}, ${sqlQuote(new Date().toISOString())});`;
    if (execTransaction) {
      try {
        // splitSqlStatements keeps each statement's own trailing `;` but returns a final unterminated tail
        // verbatim, so re-terminate before concatenating — otherwise the ledger INSERT fuses onto the last
        // statement and the whole file fails to parse.
        const script = statements.map((statement) => (statement.endsWith(";") ? statement : `${statement};`)).join("\n");
        await execTransaction.call(db, `${script}\n${ledger}`);
        count += 1;
        continue;
      } catch (error) {
        // ONLY drift falls through. Any other failure rethrows here, with the transaction already rolled back --
        // so boot dies loudly against a database in exactly the state it started in. Retrying a genuinely broken
        // file through the per-statement path would re-apply its valid statements after the rollback and leave
        // precisely the partial state this fix exists to prevent.
        if (!/duplicate column|already exists/i.test(errorMessage(error))) throw error;
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "selfhost_migration_transaction_failed",
            file,
            message: errorMessage(error),
          }),
        );
      }
    }
    for (const statement of statements) {
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
