// Units for the SQL migration-safety linter (#2022). Own file (not enrichment.test.ts) so concurrent analyzer
// PRs don't collide. No network involved — pure compute over added patch lines. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMigrationLine,
  isMigrationPath,
  scanPatchForMigrationSafety,
  scanMigrationSafety,
} from "../dist/analyzers/migration-safety.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("isMigrationPath: recognizes migrations/, db/migrate/, and bare .sql paths", () => {
  assert.equal(isMigrationPath("migrations/0001_init.sql"), true);
  assert.equal(isMigrationPath("apps/api/migration/20240101_users.ts"), true);
  assert.equal(isMigrationPath("db/migrate/20240101000000_add_users.rb"), true);
  assert.equal(isMigrationPath("scripts/seed-data.sql"), true);
  assert.equal(isMigrationPath("schema.sql"), true);
  assert.equal(isMigrationPath("src/services/scoring.ts"), false);
  assert.equal(isMigrationPath("docs/migrations.md"), false);
});

test("classifyMigrationLine: maps each risky DDL shape to its kind", () => {
  assert.equal(classifyMigrationLine("DROP TABLE legacy_events;"), "drop");
  assert.equal(classifyMigrationLine("TRUNCATE TABLE legacy_events;"), "truncate");
  assert.equal(
    classifyMigrationLine("ALTER TABLE users ADD COLUMN age INTEGER NOT NULL;"),
    "not-null-no-default",
  );
  assert.equal(
    classifyMigrationLine("ALTER TABLE users ALTER COLUMN email SET NOT NULL;"),
    "set-not-null",
  );
  assert.equal(
    classifyMigrationLine("CREATE INDEX idx_users_email ON users(email);"),
    "blocking-index",
  );
  assert.equal(classifyMigrationLine("SELECT 1;"), null);
});

test("scanPatchForMigrationSafety: flags TRUNCATE as truncate", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0015_truncate.sql",
    patchOf(["TRUNCATE TABLE legacy_events;", "TRUNCATE users;"]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["truncate", "truncate"],
  );
});

test("scanPatchForMigrationSafety: flags ALTER COLUMN SET NOT NULL without a DEFAULT as set-not-null", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0016_set_not_null.sql",
    patchOf([
      "ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
      "ALTER TABLE users ALTER COLUMN phone SET NOT NULL;",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["set-not-null", "set-not-null"],
  );
});

test("scanPatchForMigrationSafety: SET DEFAULT and SET NOT NULL on one line is safe", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0017_safe_set_not_null.sql",
    patchOf([
      "ALTER TABLE users ALTER COLUMN email SET DEFAULT '', ALTER COLUMN email SET NOT NULL;",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: SET NOT NULL on a later line is flagged even when DEFAULT is set earlier", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0017_split_set_not_null.sql",
    patchOf([
      "ALTER TABLE users ALTER COLUMN email SET DEFAULT '';",
      "ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "migrations/0017_split_set_not_null.sql", line: 2, kind: "set-not-null" },
  ]);
});

test("scanPatchForMigrationSafety: ADD COLUMN NOT NULL stays not-null-no-default, not set-not-null", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0018_add_not_null.sql",
    patchOf(["ALTER TABLE users ADD COLUMN status TEXT NOT NULL;"]),
  );
  assert.deepEqual(findings, [
    { file: "migrations/0018_add_not_null.sql", line: 1, kind: "not-null-no-default" },
  ]);
});

test("scanPatchForMigrationSafety: flags CREATE INDEX without CONCURRENTLY as blocking-index", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0019_index.sql",
    patchOf([
      "CREATE INDEX idx_users_email ON users(email);",
      "CREATE UNIQUE INDEX idx_users_email_unique ON users(email);",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["blocking-index", "blocking-index"],
  );
});

test("scanPatchForMigrationSafety: CREATE INDEX CONCURRENTLY is not flagged", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0020_concurrent_index.sql",
    patchOf([
      "CREATE INDEX CONCURRENTLY idx_users_email ON users(email);",
      "CREATE UNIQUE INDEX CONCURRENTLY idx_users_email_unique ON users(email);",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: a -- comment line mentioning TRUNCATE is not flagged", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0021_commented_truncate.sql",
    patchOf(["-- TRUNCATE TABLE users (deferred)", "SELECT 1;"]),
  );
  assert.deepEqual(findings, []);
});

test("classifyMigrationLine: DROP NOT NULL and CONCURRENTLY index builds are not flagged", () => {
  assert.equal(classifyMigrationLine("ALTER TABLE users ALTER COLUMN email DROP NOT NULL;"), null);
  assert.equal(
    classifyMigrationLine("CREATE INDEX CONCURRENTLY idx_users_email ON users(email);"),
    null,
  );
});

test("scanMigrationSafety: mixed new kinds across migration files are collected up to the cap", async () => {
  const findings = await scanMigrationSafety({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      {
        path: "migrations/0100_truncate.sql",
        patch: patchOf(["TRUNCATE TABLE staging_events;"]),
      },
      {
        path: "migrations/0101_set_not_null.sql",
        patch: patchOf(["ALTER TABLE users ALTER COLUMN email SET NOT NULL;"]),
      },
      {
        path: "migrations/0102_index.sql",
        patch: patchOf(["CREATE INDEX idx_users_email ON users(email);"]),
      },
    ],
  });
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["truncate", "set-not-null", "blocking-index"],
  );
});

test("scanPatchForMigrationSafety: flags DROP TABLE and DROP COLUMN as drop", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0002_cleanup.sql",
    patchOf(["DROP TABLE legacy_events;", "ALTER TABLE users DROP COLUMN nickname;"]),
  );
  assert.deepEqual(findings, [
    { file: "migrations/0002_cleanup.sql", line: 1, kind: "drop" },
    { file: "migrations/0002_cleanup.sql", line: 2, kind: "drop" },
  ]);
});

test("scanPatchForMigrationSafety: flags RENAME TO, RENAME [COLUMN], and RENAME TABLE as rename", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0003_rename.sql",
    patchOf([
      "ALTER TABLE users RENAME TO members;",
      "ALTER TABLE members RENAME COLUMN name TO full_name;",
      // PostgreSQL/SQLite treat the COLUMN keyword as optional — the one-step column rename must
      // still be caught without it.
      "ALTER TABLE members RENAME name TO full_name;",
      "RENAME TABLE old_logs TO logs;",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["rename", "rename", "rename", "rename"],
  );
});

test("scanPatchForMigrationSafety: flags ADD COLUMN ... NOT NULL without a DEFAULT, with or without the COLUMN keyword", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0004_add.sql",
    patchOf([
      "ALTER TABLE users ADD COLUMN age INTEGER NOT NULL;",
      "ALTER TABLE users ADD status TEXT NOT NULL;",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["not-null-no-default", "not-null-no-default"],
  );
});

test("scanPatchForMigrationSafety: a NOT NULL column WITH a DEFAULT on the same line is a safe additive change", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0005_safe.sql",
    patchOf([
      "ALTER TABLE users ADD COLUMN age INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE users ADD COLUMN bio TEXT;",
      "CREATE INDEX CONCURRENTLY idx_users_age ON users(age);",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: ADD CONSTRAINT/PRIMARY/UNIQUE/CHECK lines are not column additions", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0006_constraints.sql",
    patchOf([
      "ALTER TABLE users ADD CONSTRAINT chk_name CHECK (name IS NOT NULL);",
      "ALTER TABLE users ADD UNIQUE (email);",
      "ALTER TABLE users ADD PRIMARY KEY (id);",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: flags column-type changes (ALTER COLUMN TYPE / MODIFY COLUMN) as blocking-rewrite", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0007_retype.sql",
    patchOf([
      "ALTER TABLE events ALTER COLUMN payload TYPE JSONB;",
      "ALTER TABLE events ALTER COLUMN id SET DATA TYPE BIGINT;",
      "ALTER TABLE users MODIFY COLUMN age BIGINT;",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["blocking-rewrite", "blocking-rewrite", "blocking-rewrite"],
  );
});

test("scanPatchForMigrationSafety: a -- comment line mentioning a risky statement is not flagged", () => {
  const findings = scanPatchForMigrationSafety(
    "migrations/0008_commented.sql",
    patchOf(["-- DROP TABLE users (intentionally deferred to the next release)", "SELECT 1;"]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: a DEFAULT mentioned only in a trailing -- comment does not vouch for the column", () => {
  // The comment is stripped before the rules run, so this NOT NULL column really has no DEFAULT and is flagged.
  const findings = scanPatchForMigrationSafety(
    "migrations/0014_comment_default.sql",
    patchOf(["ALTER TABLE users ADD COLUMN age INTEGER NOT NULL; -- DEFAULT later"]),
  );
  assert.deepEqual(findings, [
    { file: "migrations/0014_comment_default.sql", line: 1, kind: "not-null-no-default" },
  ]);
});

test("scanPatchForMigrationSafety: only ADDED lines are scanned — removed and context lines are ignored", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "-DROP TABLE legacy_events;",
    " DROP TABLE archived_events;",
    "+CREATE TABLE new_events (id INTEGER);",
  ].join("\n");
  const findings = scanPatchForMigrationSafety("migrations/0009_ctx.sql", patch);
  assert.deepEqual(findings, []);
});

test("scanPatchForMigrationSafety: new-file line numbers stay correct across context and removed lines", () => {
  const patch = [
    "@@ -10,3 +10,3 @@",
    " CREATE TABLE t (id INTEGER);", // new-file line 10
    "-ALTER TABLE t ADD COLUMN a INTEGER;", // removed, does not advance
    "+ALTER TABLE t DROP COLUMN a;", // new-file line 11
  ].join("\n");
  const findings = scanPatchForMigrationSafety("migrations/0010_lines.sql", patch);
  assert.deepEqual(findings, [{ file: "migrations/0010_lines.sql", line: 11, kind: "drop" }]);
});

test("scanPatchForMigrationSafety: enforces the maxFindings cap and dedupes repeat kinds on the same line", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `DROP TABLE t_${i};`);
  const findings = scanPatchForMigrationSafety("migrations/0011_burst.sql", patchOf(lines), {
    maxFindings: 5,
  });
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5]);

  assert.deepEqual(
    scanPatchForMigrationSafety("migrations/0011_burst.sql", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanMigrationSafety: scans only migration paths and honors the global cap across files", async () => {
  const dropLines = Array.from({ length: 15 }, (_, i) => `DROP TABLE a_${i};`);
  const findings = await scanMigrationSafety({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/app.ts", patch: patchOf(["DROP TABLE not_sql_so_ignored;"]) },
      { path: "migrations/0012_a.sql", patch: patchOf(dropLines) },
      { path: "migrations/0013_b.sql", patch: patchOf(dropLines) },
    ],
  });
  assert.equal(findings.length, 20); // 15 from the first migration + capped 5 from the second
  assert.equal(findings.filter((f) => f.file === "migrations/0013_b.sql").length, 5);
});

test("scanMigrationSafety: no files yields no findings", async () => {
  assert.deepEqual(await scanMigrationSafety({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: migration-safety findings render location plus a public-safe explanation only", () => {
  const { promptSection } = renderBrief({
    migrationSafety: [
      { file: "migrations/0002_cleanup.sql", line: 1, kind: "drop" },
      { file: "migrations/0004_add.sql", line: 3, kind: "not-null-no-default" },
      { file: "migrations/0015_truncate.sql", line: 1, kind: "truncate" },
      { file: "migrations/0016_set_not_null.sql", line: 2, kind: "set-not-null" },
      { file: "migrations/0019_index.sql", line: 1, kind: "blocking-index" },
    ],
  });
  assert.match(promptSection, /SQL migration safety/);
  assert.match(promptSection, /migrations\/0002_cleanup\.sql:1/);
  assert.match(promptSection, /NOT NULL column without a DEFAULT/);
  assert.match(promptSection, /truncates a table/);
  assert.match(promptSection, /sets NOT NULL on an existing column/);
  assert.match(promptSection, /creates an index without CONCURRENTLY/);
});
