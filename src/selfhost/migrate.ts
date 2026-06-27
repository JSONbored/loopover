// Apply gittensory's D1 migrations to the self-host SQLite database at startup. The same `migrations/*.sql`
// files Cloudflare applies via `wrangler d1 migrations apply` — they're plain SQLite DDL, so they run as-is
// through the D1 adapter's exec(). Tracked in a `_selfhost_migrations` table so a restart re-applies only the
// new ones (idempotent), mirroring wrangler's migration ledger.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../utils/json";

export async function runSelfHostMigrations(db: D1Database, dir: string): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS _selfhost_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const existing = await db.prepare("SELECT name FROM _selfhost_migrations").all<{ name: string }>();
  const applied = new Set(existing.results.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    try {
      await db.exec(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      // Idempotency (#migrate-drift): a renumbered/duplicated migration whose schema change is ALREADY present (e.g. a
      // column added under an earlier filename by a prior deploy, then renumbered before merge) must not crash-loop the
      // boot. "duplicate column" / "already exists" means the target schema is satisfied — record the file applied and
      // continue. Any OTHER error is a real failure and still aborts the boot.
      if (!/duplicate column|already exists/i.test(errorMessage(error)))
        throw error;
    }
    await db.prepare("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)").bind(file, new Date().toISOString()).run();
    count += 1;
  }
  return count;
}
