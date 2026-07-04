import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "0107_repository_review_check_mode.sql";

// Replays every migrations/*.sql file BEFORE 0107 into a fresh in-memory DB (mirrors
// migration-0102-linked-issue-gate-mode.test.ts's own approach), so the table shape this test inserts into is
// exactly what migration 0107 itself was written against. The TestD1Database helper (test/helpers/d1.ts) can't
// be reused here: it concatenates and applies EVERY migration (including 0107) up front, so the new
// review_check_mode column would already be backfilled by the time a test could insert a pre-migration
// gate_check_mode='enabled' row -- there would be nothing left for 0107's UPDATE to actually backfill.
function applyMigrationsBefore(cutoffFile: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql") && file < cutoffFile)
    .sort();
  for (const file of files) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  return db;
}

function applyMigration(db: DatabaseSync, file: string): void {
  db.exec(readFileSync(`migrations/${file}`, "utf8"));
}

function insertRepositorySettingsRow(db: DatabaseSync, repoFullName: string, gateCheckMode: string): void {
  db.prepare("INSERT INTO repository_settings (repo_full_name, gate_check_mode) VALUES (?, ?)").run(repoFullName, gateCheckMode);
}

function readReviewCheckMode(db: DatabaseSync, repoFullName: string): string {
  const row = db.prepare("SELECT review_check_mode FROM repository_settings WHERE repo_full_name = ?").get(repoFullName) as
    | { review_check_mode: string }
    | undefined;
  if (!row) throw new Error(`no repository_settings row for ${repoFullName}`);
  return row.review_check_mode;
}

describe("migration 0107: review_check_mode backfill (#2852)", () => {
  it("backfills a pre-existing gate_check_mode='enabled' row to review_check_mode='required', via the real migration", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/legacy-enabled", "enabled");

    applyMigration(db, MIGRATION_FILE);

    expect(readReviewCheckMode(db, "acme/legacy-enabled")).toBe("required");
  });

  it("leaves a pre-existing gate_check_mode='off' row on the new column's default 'disabled'", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/legacy-off", "off");

    applyMigration(db, MIGRATION_FILE);

    expect(readReviewCheckMode(db, "acme/legacy-off")).toBe("disabled");
  });

  // The backfill's WHERE clause is an exact match on 'enabled' -- any other legacy/unrecognized value (not
  // just the documented 'off') must fail closed to the new column's 'disabled' default rather than publish
  // the check-run for a repo that never explicitly opted in.
  it("leaves a row with an unrecognized legacy gate_check_mode value on the new column's default 'disabled'", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/legacy-weird", "weird-legacy-value");

    applyMigration(db, MIGRATION_FILE);

    expect(readReviewCheckMode(db, "acme/legacy-weird")).toBe("disabled");
  });

  it("backfills multiple pre-existing rows independently in one migration run", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/legacy-enabled-1", "enabled");
    insertRepositorySettingsRow(db, "acme/legacy-enabled-2", "enabled");
    insertRepositorySettingsRow(db, "acme/legacy-off-1", "off");

    applyMigration(db, MIGRATION_FILE);

    expect(readReviewCheckMode(db, "acme/legacy-enabled-1")).toBe("required");
    expect(readReviewCheckMode(db, "acme/legacy-enabled-2")).toBe("required");
    expect(readReviewCheckMode(db, "acme/legacy-off-1")).toBe("disabled");
  });
});
