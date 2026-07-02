import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run scripts/check-migrations.mjs over a throwaway fixture dir (via CHECK_MIGRATIONS_DIR) and normalize the
// pass/fail into { status, out }. On a non-zero exit execFileSync throws; the violation text is on stderr.
function runCheck(files: Record<string, string>): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "gtmig-check-"));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-migrations.mjs"], {
      encoding: "utf8",
      env: { ...process.env, CHECK_MIGRATIONS_DIR: dir },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check-migrations script", () => {
  it("reports every grandfathered duplicate migration number in the success summary", () => {
    const output = execFileSync(process.execPath, ["scripts/check-migrations.mjs"], { encoding: "utf8" });

    expect(output).toContain("(3 grandfathered duplicates: 0015, 0017, 0074)");
  });

  it.each([
    ["TEMP keyword", "CREATE TEMP TABLE scratch AS SELECT 1;"],
    ["TEMPORARY keyword", "CREATE TEMPORARY VIEW scratch AS SELECT 1;"],
    ["temp schema table", "CREATE TABLE temp.scratch AS SELECT 1;"],
    ["temp schema index", "CREATE INDEX IF NOT EXISTS temp.scratch_idx ON scratch(id);"],
    ["temp schema unique index", "CREATE UNIQUE INDEX temp.scratch_idx ON scratch(id);"],
    ["double-quoted temp schema", 'CREATE TABLE "temp".scratch AS SELECT 1;'],
    ["double-quoted temp schema, both sides quoted", 'CREATE TABLE "temp"."scratch" AS SELECT 1;'],
    ["backtick-quoted temp schema", "CREATE TABLE `temp`.scratch AS SELECT 1;"],
    ["bracket-quoted temp schema", "CREATE TABLE [temp].scratch AS SELECT 1;"],
    ["single-quoted temp schema (SQLite's single-quote-as-identifier misfeature)", "CREATE TABLE 'temp'.scratch AS SELECT 1;"],
  ])("rejects a migration that creates a temporary object via %s (the D1 remote authorizer blocks it)", (_name, sql) => {
    const r = runCheck({ "0001_temp.sql": `${sql}\n` });

    expect(r.status).toBe(1);
    expect(r.out).toContain("0001_temp.sql:1");
    expect(r.out).toMatch(/SQLITE_AUTH/);
    expect(r.out).toMatch(/temporary object/i);
  });

  it("rejects explicit transaction control and points at each offending statement line", () => {
    const r = runCheck({ "0001_txn.sql": "BEGIN;\nUPDATE t SET x = 1;\nCOMMIT;\n" });

    expect(r.status).toBe(1);
    expect(r.out).toContain("0001_txn.sql:1"); // BEGIN
    expect(r.out).toContain("0001_txn.sql:3"); // COMMIT — line points at the keyword, not the preceding `;`
  });

  it.each(["ATTACH DATABASE 'x' AS x;", "DETACH DATABASE x;", "VACUUM;", "PRAGMA foreign_keys = ON;"])(
    "rejects the D1-unsupported statement: %s",
    (stmt) => {
      const r = runCheck({ "0001_stmt.sql": `${stmt}\n` });

      expect(r.status).toBe(1);
      expect(r.out).toContain("0001_stmt.sql:1");
    },
  );

  it("does not flag forbidden keywords that appear only in a comment, a string, or a trigger body", () => {
    const r = runCheck({
      "0001_ok.sql":
        "-- this migration does not VACUUM or PRAGMA anything\n" +
        "CREATE TABLE t (note TEXT DEFAULT 'please COMMIT and ATTACH nothing');\n" +
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET note = 'x'; END;\n",
    });

    expect(r.status).toBe(0);
    expect(r.out).toContain("1 migrations OK");
  });

  it("does not flag a single-quoted VALUE that literally contains the temp-schema pattern's text, since it is not schema-qualifying a dot", () => {
    // The temp-schema alternative in D1_FORBIDDEN has no start-of-statement anchor (unlike attach/vacuum/
    // pragma/etc.), so a single-quoted value's content can't be blanket-preserved just because SOME
    // single-quoted tokens are legitimately identifiers (see the SQLite single-quote-misfeature test
    // above) -- only a value immediately followed by a `.` is treated as an identifier.
    const r = runCheck({
      "0001_ok.sql": "INSERT INTO logs (msg) VALUES ('create temporary object warning');\n",
    });

    expect(r.status).toBe(0);
    expect(r.out).toContain("1 migrations OK");
  });

  it("does not flag a CREATE UNIQUE INDEX that is not in the temp schema", () => {
    const r = runCheck({ "0001_ok.sql": "CREATE UNIQUE INDEX idx_t_id ON t(id);\n" });

    expect(r.status).toBe(0);
    expect(r.out).toContain("1 migrations OK");
  });

  it("does not flag a quoted identifier that merely contains \"temp\" without a schema-qualifying dot", () => {
    const r = runCheck({
      "0001_ok.sql":
        'CREATE TABLE "temp_settings" (id INTEGER PRIMARY KEY);\n' + "CREATE TABLE `temp_cache` (id INTEGER PRIMARY KEY);\n",
    });

    expect(r.status).toBe(0);
    expect(r.out).toContain("1 migrations OK");
  });

  it.each([
    ["double-quoted column name", 'CREATE TABLE t ("create temp note" TEXT);'],
    ["backtick-quoted column name", "CREATE TABLE t (`create temp note` TEXT);"],
    ["bracket-quoted column name", "CREATE TABLE t ([create temp note] TEXT);"],
  ])(
    "does not flag a %s that merely spells out the forbidden phrase, since the temp-schema pattern is unanchored and only a schema-qualifying dot should expose quoted identifier text to it",
    (_name, sql) => {
      const r = runCheck({ "0001_ok.sql": `${sql}\n` });

      expect(r.status).toBe(0);
      expect(r.out).toContain("1 migrations OK");
    },
  );
});
