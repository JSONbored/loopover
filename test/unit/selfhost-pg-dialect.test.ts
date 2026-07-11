import { describe, expect, it } from "vitest";
import { stripConflictTargetQualifiers, toNumberedPlaceholders, translateDdl, translateFunctions, translateInsertOr, translateMigrationInserts, translateRowid, translateSql } from "../../src/selfhost/pg-dialect";

describe("pg-dialect (#977 SQLite → Postgres)", () => {
  it("numbers placeholders, skipping `?` inside string literals", () => {
    expect(toNumberedPlaceholders("SELECT * FROM t WHERE a=? AND b=?")).toBe("SELECT * FROM t WHERE a=$1 AND b=$2");
    expect(toNumberedPlaceholders("SELECT '?' AS lit WHERE a=?")).toBe("SELECT '?' AS lit WHERE a=$1");
  });

  it("REGRESSION: reuses a SQLite numbered placeholder's own index instead of corrupting it via the anonymous counter", () => {
    // Before the fix: `?1` scanned as anonymous `?` (→ $1) followed by a literal `1`, corrupting to `$11`
    // — a bind index Postgres has no value for. retentionWhere() (retention.ts) and claimRegateFanoutSlot()
    // (repositories.ts) both use this numbered syntax.
    expect(toNumberedPlaceholders("created_at < ?1")).toBe("created_at < $1");
    expect(toNumberedPlaceholders("last_regate_fanout_at = ?1 WHERE id = 'singleton' AND (x IS NULL OR x < ?2)")).toBe(
      "last_regate_fanout_at = $1 WHERE id = 'singleton' AND (x IS NULL OR x < $2)",
    );
    // A later anonymous `?` continues from the highest index already assigned (SQLite's own rule), so it
    // must not collide with an earlier numbered placeholder.
    expect(toNumberedPlaceholders("a=?1 AND b=?")).toBe("a=$1 AND b=$2");
    // A literal `?1` inside a string is left untouched, same as a bare `?` literal.
    expect(toNumberedPlaceholders("SELECT '?1' AS lit WHERE a=?")).toBe("SELECT '?1' AS lit WHERE a=$1");
  });

  it("translates datetime/strftime/CURRENT_TIMESTAMP/json to Postgres (text-returning to match SQLite)", () => {
    expect(translateFunctions("x > datetime('now', ?)")).toContain("to_char(now() + (?)::interval");
    expect(translateFunctions("datetime('now')")).toContain("to_char(now(),");
    expect(translateFunctions("strftime('%Y-W%W', created_at)")).toContain(`to_char((created_at)::timestamptz, 'YYYY"-W"WW')`);
    expect(translateFunctions("strftime('%Y-%m', created_at)")).toContain("'YYYY-MM'");
    expect(translateFunctions("CURRENT_TIMESTAMP")).toContain("to_char(now(),");
    expect(translateFunctions("json_extract(meta, '$.mode')")).toBe("((meta)::jsonb ->> 'mode')");
  });

  it("REGRESSION (#4997): a JSON-boolean json_extract comparison survives translation as text-to-text, not text-to-integer", () => {
    // findHottestInconclusiveReviewTargetForRepo (repositories.ts) compares a stored JSON boolean. SQLite's
    // json_extract surfaces a JSON boolean as the SQL integer 1/0, but Postgres's `->>` ALWAYS returns text --
    // comparing that text against a bare integer literal (the original `= 1`) throws a Postgres type-mismatch
    // error on every call. CAST to TEXT first so the comparison is valid on both backends.
    const translated = translateFunctions("CAST(json_extract(metadata_json, '$.inconclusive') AS TEXT) IN ('1', 'true')");
    expect(translated).toBe("CAST(((metadata_json)::jsonb ->> 'inconclusive') AS TEXT) IN ('1', 'true')");
    // No bare-integer comparison against a json_extract/->> expression should remain anywhere in the codebase --
    // this is the ONE call site, and it's fixed. (Documents the invariant the fix restores; not itself testing
    // translateFunctions with anything new.)
    expect(translated).not.toMatch(/->>\s*'[a-z]+'\s*\)?\s*=\s*\d/);
  });

  it("translates INSERT OR IGNORE / REPLACE to ON CONFLICT", () => {
    expect(translateInsertOr("INSERT OR IGNORE INTO t (a) VALUES (?)")).toBe("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING");
    const replace = translateInsertOr("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)");
    expect(replace).toContain("INSERT INTO system_flags");
    expect(replace).toContain("ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    expect(() => translateInsertOr("INSERT OR REPLACE INTO unknown_tbl (a) VALUES (?)")).toThrow(/no known conflict key/);
    expect(translateInsertOr("SELECT 1")).toBe("SELECT 1"); // passthrough
  });

  it("translateSql composes all passes; translateDdl handles the ISO-now default", () => {
    expect(translateSql("SELECT * FROM t WHERE updated_at > datetime('now', ?)")).toMatch(/\$1/);
    expect(translateDdl("created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")).toContain("to_char(now() AT TIME ZONE 'UTC'");
  });

  it("translates an INSERT OR IGNORE seed embedded in a (multi-statement) migration file", () => {
    // The 0059_global_agent_controls seed — runSelfHostMigrations exec()s the whole file, so the
    // statement-anchored translateInsertOr can't reach this; translateMigrationInserts handles it.
    expect(translateMigrationInserts("INSERT OR IGNORE INTO global_agent_controls (id, frozen) VALUES ('singleton', 0);"))
      .toBe("INSERT INTO global_agent_controls (id, frozen) VALUES ('singleton', 0) ON CONFLICT DO NOTHING;");
    // Works mid-file alongside DDL, and leaves non-INSERT-OR statements untouched.
    const file = "CREATE TABLE t (a INTEGER);\nINSERT OR IGNORE INTO t (a) VALUES (1);\n";
    const out = translateMigrationInserts(file);
    expect(out).toContain("CREATE TABLE t (a INTEGER);");
    expect(out).toContain("INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING;");
    expect(translateMigrationInserts("CREATE TABLE t (a INTEGER);")).toBe("CREATE TABLE t (a INTEGER);"); // no-op
  });

  it("translateDdl applies INSERT OR IGNORE + function translation together", () => {
    const out = translateDdl("INSERT OR IGNORE INTO t (a, at) VALUES (1, CURRENT_TIMESTAMP);");
    expect(out).toContain("ON CONFLICT DO NOTHING");
    expect(out).toContain("to_char(now(),"); // CURRENT_TIMESTAMP still translated
    expect(out).not.toMatch(/INSERT\s+OR\s+IGNORE/i);
  });

  it("strips table qualifiers from an ON CONFLICT target (drizzle emits `\"t\".\"c\"`, which Postgres rejects)", () => {
    // The exact shape drizzle-orm/d1 emits for recordWebhookEvent — a table-qualified conflict target.
    expect(stripConflictTargetQualifiers('INSERT INTO "webhook_events" ("delivery_id") VALUES (?) ON CONFLICT ("webhook_events"."delivery_id") DO UPDATE SET "status" = ?'))
      .toBe('INSERT INTO "webhook_events" ("delivery_id") VALUES (?) ON CONFLICT ("delivery_id") DO UPDATE SET "status" = ?');
    // Multiple qualified conflict columns are each unqualified.
    expect(stripConflictTargetQualifiers('... ON CONFLICT ("t"."a", "t"."b") DO NOTHING')).toBe('... ON CONFLICT ("a", "b") DO NOTHING');
  });

  it("leaves an already-unqualified ON CONFLICT and a bare ON CONFLICT DO NOTHING untouched", () => {
    expect(stripConflictTargetQualifiers('ON CONFLICT ("key") DO UPDATE SET v=excluded.v')).toBe('ON CONFLICT ("key") DO UPDATE SET v=excluded.v');
    expect(stripConflictTargetQualifiers("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING")).toBe("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING");
    expect(stripConflictTargetQualifiers("SELECT 1")).toBe("SELECT 1"); // no ON CONFLICT at all
  });

  it("only de-qualifies inside the conflict target — qualified refs elsewhere are preserved", () => {
    // The WHERE-clause qualifier must survive; only the ON CONFLICT target is rewritten.
    const out = stripConflictTargetQualifiers('UPDATE x SET "x"."a"=? WHERE "x"."id"=? ON CONFLICT ("x"."id") DO NOTHING');
    expect(out).toContain('"x"."a"=?');
    expect(out).toContain('WHERE "x"."id"=?');
    expect(out).toContain('ON CONFLICT ("id")');
  });

  it("translateSql de-qualifies the conflict target AND numbers placeholders (the real webhook upsert)", () => {
    const drizzle = 'insert into "webhook_events" ("delivery_id", "status") values (?, ?) on conflict ("webhook_events"."delivery_id") do update set "status" = ?';
    const out = translateSql(drizzle);
    expect(out).toContain('on conflict ("delivery_id")'); // qualifier stripped → valid Postgres
    expect(out).not.toContain('"webhook_events"."delivery_id"');
    expect(out).toContain("values ($1, $2)"); // placeholders numbered
    expect(out).toContain("set \"status\" = $3");
  });

  it("translates the rowid pseudo-column to Postgres's ctid system column", () => {
    expect(translateRowid("SELECT rowid FROM t WHERE a = ?")).toBe("SELECT ctid FROM t WHERE a = ?");
    expect(translateRowid("ORDER BY rowid DESC")).toBe("ORDER BY ctid DESC");
    expect(translateRowid("ORDER BY ROWID ASC")).toBe("ORDER BY ctid ASC"); // case-insensitive
    // Only the bare `rowid` token is rewritten — identifiers that merely contain it are left alone.
    expect(translateRowid("SELECT row_id, my_rowid_col FROM t")).toBe("SELECT row_id, my_rowid_col FROM t");
    expect(translateRowid("SELECT 1")).toBe("SELECT 1"); // no-op passthrough
  });

  it("REGRESSION (self-host Postgres prune-retention dead-letter): translateSql strips rowid from the exact batched-delete shape retention.ts emits", () => {
    // The literal shape src/db/retention.ts's pruneExpiredRecords() builds for its bounded batched delete.
    // Before the fix, this reached Postgres verbatim and failed with `column "rowid" does not exist`.
    const deleteSql = 'DELETE FROM ai_usage_events WHERE rowid IN (SELECT rowid FROM ai_usage_events WHERE created_at < ?1 LIMIT 1000)';
    const out = translateSql(deleteSql);
    expect(out.toLowerCase()).not.toContain("rowid");
    expect(out).toBe("DELETE FROM ai_usage_events WHERE ctid IN (SELECT ctid FROM ai_usage_events WHERE created_at < $1 LIMIT 1000)");
  });

  it("also fixes the rowid tie-break ORDER BY used by orb/relay.ts enrollment resolution", () => {
    const sql = "SELECT relay_mode FROM orb_enrollments WHERE installation_id = ? ORDER BY enrolled_at DESC, rowid DESC";
    const out = translateSql(sql);
    expect(out.toLowerCase()).not.toContain("rowid");
    expect(out).toContain("ORDER BY enrolled_at DESC, ctid DESC");
  });
});
