import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { translateAutoincrementPrimaryKey, translateDdl } from "../../src/selfhost/pg-dialect";

// #10138: migrations are authored in SQLite dialect and translated for Postgres by translateDdl. A construct
// nobody thought to translate is a BOOT failure, not a test failure -- runSelfHostMigrations aborts, the
// process exits, and every Orb upgrading past that migration crash-loops.
//
// That is not hypothetical. 0209 shipped `INTEGER PRIMARY KEY AUTOINCREMENT`, which Postgres cannot parse
// (SQLSTATE 42601), and every Orb past 0208 failed to start until it was translated.
//
// The real-Postgres suite (test/integration/selfhost-pg.test.ts, "applies every migration") DID catch it --
// but it only runs in selfhost.yml, which is push-to-main only, so the signal arrived AFTER the merge that
// caused it. This file is the pre-merge counterpart: no service container, no Docker, no Postgres, a few
// milliseconds inside the unit run that already happens. It cannot replace the real-PG suite (it proves
// nothing about semantics) and does not try to -- it exists to make THIS failure class impossible to merge.
//
// ── DERIVED FROM THE TRANSLATOR, NOT RESTATED ────────────────────────────────────────────────────────────
// The assertion runs translateDdl over each migration and checks the OUTPUT. A hand-maintained list of
// "banned strings in migration source" would be a second source of truth that drifts the moment someone adds
// a translation, and would also produce false failures for constructs the translator legitimately handles.
// Checking post-translation means adding a translation automatically satisfies this test, and removing one
// automatically fails it.

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

/** SQLite-only constructs that Postgres cannot parse. Each is a hard 42601-class parse error, so surviving
 *  translation means an Orb that will not boot. Deliberately narrow: only tokens whose presence in a
 *  Postgres statement is unambiguously fatal, so this can never fail a portable migration. */
const SQLITE_ONLY_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; construct: string; fix: string }> = [
  {
    pattern: /\bAUTOINCREMENT\b/i,
    construct: "AUTOINCREMENT",
    fix: "write `INTEGER PRIMARY KEY AUTOINCREMENT` (translateAutoincrementPrimaryKey renders it as a Postgres identity column), or use a non-surrogate key",
  },
  {
    pattern: /\bINSERT\s+OR\s+REPLACE\b/i,
    construct: "INSERT OR REPLACE",
    fix: "use `INSERT ... ON CONFLICT (<key>) DO UPDATE`; the translator deliberately does not guess a conflict target",
  },
  {
    pattern: /\bWITHOUT\s+ROWID\b/i,
    construct: "WITHOUT ROWID",
    fix: "drop it -- it is a SQLite storage hint with no Postgres equivalent and no semantic effect worth porting",
  },
  {
    pattern: /\bPRAGMA\b/i,
    construct: "PRAGMA",
    fix: "drop it -- PRAGMA is a SQLite-only statement; per-connection settings belong in the adapter, not a migration",
  },
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Strip SQL comments before scanning. Not cosmetic -- without it this check is unusable.
 *
 * These migrations are heavily commented, and the comments discuss the very constructs being banned: 0054's
 * header documents `INSERT OR REPLACE` as the writer's behaviour, 0176 explains why an ingest path used it,
 * and 0180 annotates a column with "NOT autoincrement". All three parse and run fine on Postgres; flagging
 * them would train the next person to ignore this test, which is worse than not having it.
 *
 * `--` inside a string literal would be over-stripped. Accepted deliberately: that can only cause a false
 * PASS, never a false failure, and the real-Postgres suite is the backstop for anything this misses. A
 * checker that cries wolf gets muted; one that occasionally stays quiet does not.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

describe("migration dialect portability (#10138)", () => {
  it("sanity: there are migrations to check, so a broken glob cannot pass this file vacuously", () => {
    // Without this, a wrong MIGRATIONS_DIR makes every assertion below iterate an empty list and report
    // green -- the exact "verifier that passes because it checked nothing" failure the gate exists to catch.
    expect(migrationFiles().length).toBeGreaterThan(200);
  });

  it("INVARIANT: no SQLite-only construct survives translateDdl, for every shipped migration", () => {
    const offenders: string[] = [];
    for (const name of migrationFiles()) {
      const translated = stripSqlComments(translateDdl(readFileSync(join(MIGRATIONS_DIR, name), "utf8")));
      for (const { pattern, construct, fix } of SQLITE_ONLY_CONSTRUCTS) {
        if (pattern.test(translated)) offenders.push(`${name}: ${construct} survives translation — ${fix}`);
      }
    }
    // Asserted as the full list rather than a count, so the failure message names the file and the remedy
    // instead of making the next person bisect the migrations directory.
    expect(offenders).toEqual([]);
  });

  it("SELF-TEST: the check still fires on real DDL, and only comments are exempt", () => {
    // Comment-stripping is how this check avoids crying wolf, and it is also how it could be silently
    // neutered -- a broader strip that swallowed real statements would make the invariant above pass
    // unconditionally. Both directions are pinned here rather than trusted.
    const detect = (sql: string): boolean =>
      SQLITE_ONLY_CONSTRUCTS.some(({ pattern }) => pattern.test(stripSqlComments(translateDdl(sql))));

    // An UNTRANSLATED SQLite-only construct in live DDL is still caught.
    expect(detect("CREATE TABLE t (id INTEGER NOT NULL) WITHOUT ROWID;")).toBe(true);
    expect(detect("INSERT OR REPLACE INTO t VALUES (1);")).toBe(true);
    // The same text inside a comment is not.
    expect(detect("-- WITHOUT ROWID is a SQLite thing\nCREATE TABLE t (id INTEGER NOT NULL);")).toBe(false);
    expect(detect("/* INSERT OR REPLACE was the old writer */\nCREATE TABLE t (id INTEGER);")).toBe(false);
    // And the construct this incident was about is caught when NOT translated, which is what proves the
    // green result below comes from the translation rather than from the scan missing it.
    expect(SQLITE_ONLY_CONSTRUCTS.some(({ pattern }) => pattern.test("id INTEGER PRIMARY KEY AUTOINCREMENT"))).toBe(true);
  });

  it("REGRESSION (#10138): 0209 is the migration that proved this, and it now translates cleanly", () => {
    // Pinned by name. The general invariant above would still pass if 0209 were deleted; this says the
    // specific thing that broke production is fixed, and fails loudly if someone reverts the translation.
    const sql = readFileSync(join(MIGRATIONS_DIR, "0209_service_status_samples.sql"), "utf8");
    expect(sql).toMatch(/AUTOINCREMENT/i); // the source is still SQLite dialect, by design -- migrations are immutable
    expect(translateDdl(sql)).not.toMatch(/AUTOINCREMENT/i);
    expect(translateDdl(sql)).toMatch(/BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY/);
  });
});

describe("translateAutoincrementPrimaryKey", () => {
  it("renders SQLite's auto-assigning surrogate key as a Postgres identity column", () => {
    expect(translateAutoincrementPrimaryKey("id INTEGER PRIMARY KEY AUTOINCREMENT,")).toBe(
      "id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,",
    );
  });

  it("tolerates the whitespace real migrations are written with (aligned columns, newlines)", () => {
    expect(translateAutoincrementPrimaryKey("  id          INTEGER   PRIMARY  KEY   AUTOINCREMENT,")).toContain(
      "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );
    expect(translateAutoincrementPrimaryKey("id INTEGER\n  PRIMARY KEY\n  AUTOINCREMENT,")).toContain(
      "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );
  });

  it("is case-insensitive, matching how SQL is actually written", () => {
    expect(translateAutoincrementPrimaryKey("id integer primary key autoincrement,")).toContain(
      "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );
  });

  it("BY DEFAULT, never ALWAYS — SQLite allows an explicit id and ALWAYS would reject one", () => {
    // A caller supplying its own key is legal in SQLite; GENERATED ALWAYS would turn that into a runtime
    // error on Postgres only, which is exactly the kind of dialect-dependent behaviour change this
    // translation layer exists to prevent.
    const out = translateAutoincrementPrimaryKey("id INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(out).toContain("GENERATED BY DEFAULT AS IDENTITY");
    expect(out).not.toContain("GENERATED ALWAYS");
  });

  it("BIGINT, not INTEGER — SQLite's rowid is 64-bit and narrowing it would silently cap the table", () => {
    expect(translateAutoincrementPrimaryKey("id INTEGER PRIMARY KEY AUTOINCREMENT")).toMatch(/^id BIGINT\b/);
  });

  it("leaves a plain INTEGER PRIMARY KEY alone — it parses on both dialects and is the house pattern", () => {
    // Every other table in the repo uses this. Rewriting it would change the meaning of ~200 migrations to
    // fix one, and would make previously-explicit ids auto-assign.
    expect(translateAutoincrementPrimaryKey("id INTEGER PRIMARY KEY,")).toBe("id INTEGER PRIMARY KEY,");
  });

  it("does not touch a column merely named like the keyword", () => {
    expect(translateAutoincrementPrimaryKey("autoincrement_enabled INTEGER NOT NULL")).toBe(
      "autoincrement_enabled INTEGER NOT NULL",
    );
  });

  it("translates every occurrence, not just the first — one file may declare several tables", () => {
    const two = "a INTEGER PRIMARY KEY AUTOINCREMENT, b INTEGER PRIMARY KEY AUTOINCREMENT";
    expect(translateAutoincrementPrimaryKey(two).match(/GENERATED BY DEFAULT AS IDENTITY/g)).toHaveLength(2);
  });

  it("is reached through translateDdl, which is what pg-adapter actually calls", () => {
    // The unit above proves the rewrite; this proves it is WIRED. A correct translation that the DDL path
    // never invokes is the same outage.
    expect(translateDdl("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);")).toContain(
      "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );
  });
});
