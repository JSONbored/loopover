// Apply gittensory's D1 migrations to the self-host SQLite database at startup. The same `migrations/*.sql`
// files Cloudflare applies via `wrangler d1 migrations apply` — they're plain SQLite DDL, so they run as-is
// through the D1 adapter's exec(). Tracked in a `_selfhost_migrations` table so a restart re-applies only the
// new ones (idempotent), mirroring wrangler's migration ledger.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runSelfHostMigrations(db: D1Database, dir: string): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS _selfhost_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const existing = await db.prepare("SELECT name FROM _selfhost_migrations").all<{ name: string }>();
  const applied = new Set(existing.results.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    await db.exec(readFileSync(join(dir, file), "utf8"));
    await db.prepare("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)").bind(file, new Date().toISOString()).run();
    count += 1;
  }
  return count;
}
