import { describe, expect, it } from "vitest";
import { toNumberedPlaceholders, translateDdl, translateFunctions, translateInsertOr, translateSql } from "../../src/selfhost/pg-dialect";

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
});
