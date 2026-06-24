import { describe, expect, it } from "vitest";
import { stripConflictTargetQualifiers, toNumberedPlaceholders, translateDdl, translateFunctions, translateInsertOr, translateMigrationInserts, translateSql } from "../../src/selfhost/pg-dialect";

describe("pg-dialect (#977 SQLite → Postgres)", () => {
  it("numbers placeholders, skipping `?` inside string literals", () => {
    expect(toNumberedPlaceholders("SELECT * FROM t WHERE a=? AND b=?")).toBe("SELECT * FROM t WHERE a=$1 AND b=$2");
    expect(toNumberedPlaceholders("SELECT '?' AS lit WHERE a=?")).toBe("SELECT '?' AS lit WHERE a=$1");
  });

  it("translates datetime/strftime/CURRENT_TIMESTAMP/json to Postgres (text-returning to match SQLite)", () => {
    expect(translateFunctions("x > datetime('now', ?)")).toContain("to_char(now() + (?)::interval");
    expect(translateFunctions("datetime('now')")).toContain("to_char(now(),");
    expect(translateFunctions("strftime('%Y-W%W', created_at)")).toContain(`to_char((created_at)::timestamptz, 'YYYY"-W"WW')`);
    expect(translateFunctions("strftime('%Y-%m', created_at)")).toContain("'YYYY-MM'");
    expect(translateFunctions("CURRENT_TIMESTAMP")).toContain("to_char(now(),");
    expect(translateFunctions("json_extract(meta, '$.mode')")).toBe("((meta)::jsonb ->> 'mode')");
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
});
