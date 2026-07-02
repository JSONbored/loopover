import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// Regression coverage for migrations/0095, the one-time repair for pull_request_detail_sync_state.reviews_synced_at
// (#2595 review fix). Every pre-existing writer (backfillOpenPullRequestDetails / refreshPullRequestDetails /
// backfillRepository, all in src/github/backfill.ts) stamped this column UNCONDITIONALLY on every sync pass,
// success or failure -- so an existing row's marker cannot be trusted once the new durable review cache starts
// treating ANY non-null value as "reviews are fully synced, never refetch." These tests pin the repair
// migration's exact behavior against the REAL migration file so a future edit can't silently narrow or widen
// what gets cleared.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const migrationSql = (name: string) => readFileSync(join(migrationsDir, name), "utf8");

type Row = {
  id: string;
  status: string;
  files_synced_at: string | null;
  reviews_synced_at: string | null;
  checks_synced_at: string | null;
  head_sha: string | null;
};

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationSql("0006_open_data_completeness.sql"));
  db.exec(migrationSql("0092_pull_request_detail_sync_head_sha.sql"));
  db.exec(migrationSql("0094_pull_request_detail_sync_pr_state.sql"));
  return db;
}

function insert(
  db: DatabaseSync,
  row: {
    id: string;
    repo_full_name: string;
    pull_number: number;
    status?: string;
    files_synced_at?: string | null;
    reviews_synced_at?: string | null;
    checks_synced_at?: string | null;
    head_sha?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO pull_request_detail_sync_state (id, repo_full_name, pull_number, status, files_synced_at, reviews_synced_at, checks_synced_at, head_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.repo_full_name,
    row.pull_number,
    row.status ?? "never_synced",
    row.files_synced_at ?? null,
    row.reviews_synced_at ?? null,
    row.checks_synced_at ?? null,
    row.head_sha ?? null,
  );
}

function allRows(db: DatabaseSync): Row[] {
  return db
    .prepare("SELECT id, status, files_synced_at, reviews_synced_at, checks_synced_at, head_sha FROM pull_request_detail_sync_state ORDER BY id")
    .all() as unknown as Row[];
}

describe("0095 reviews_synced_at repair migration", () => {
  it("clears reviews_synced_at on every row that has it set, regardless of status, while leaving OTHER columns untouched", () => {
    const db = freshDb();
    // A "complete" row (reviews genuinely succeeded on the pass that set this) -- still cleared: there is no
    // reliable way to tell a trustworthy stamp from an untrustworthy one from the row alone (status reflects the
    // aggregate files/reviews/checks outcome, not reviews specifically), so the migration clears unconditionally
    // by design rather than guessing.
    insert(db, {
      id: "p1",
      repo_full_name: "o/r",
      pull_number: 1,
      status: "complete",
      files_synced_at: "2026-01-01T00:00:00Z",
      reviews_synced_at: "2026-01-01T00:00:00Z",
      checks_synced_at: "2026-01-01T00:00:00Z",
      head_sha: "sha1",
    });
    // A "partial" row -- the exact scenario the bug is about: reviews_synced_at was stamped even though this
    // pass (files, reviews, or checks) had a failure.
    insert(db, {
      id: "p2",
      repo_full_name: "o/r",
      pull_number: 2,
      status: "partial",
      files_synced_at: "2026-01-02T00:00:00Z",
      reviews_synced_at: "2026-01-02T00:00:00Z",
      checks_synced_at: null,
      head_sha: "sha2",
    });
    // A row that never had reviews synced at all -- must remain untouched (already NULL, nothing to clear).
    insert(db, { id: "p3", repo_full_name: "o/r", pull_number: 3, status: "never_synced" });

    db.exec(migrationSql("0095_repair_reviews_synced_at.sql"));

    const rows = allRows(db);
    expect(rows.find((r) => r.id === "p1")).toMatchObject({
      reviews_synced_at: null,
      files_synced_at: "2026-01-01T00:00:00Z",
      checks_synced_at: "2026-01-01T00:00:00Z",
      head_sha: "sha1",
      status: "complete",
    });
    expect(rows.find((r) => r.id === "p2")).toMatchObject({
      reviews_synced_at: null,
      files_synced_at: "2026-01-02T00:00:00Z",
      checks_synced_at: null,
      head_sha: "sha2",
      status: "partial",
    });
    expect(rows.find((r) => r.id === "p3")).toMatchObject({
      reviews_synced_at: null,
      files_synced_at: null,
      checks_synced_at: null,
      head_sha: null,
      status: "never_synced",
    });
  });

  it("is a no-op on a table with no rows", () => {
    const db = freshDb();

    expect(() => db.exec(migrationSql("0095_repair_reviews_synced_at.sql"))).not.toThrow();

    expect(allRows(db)).toEqual([]);
  });

  it("is idempotent — running it twice has the same effect as running it once", () => {
    const db = freshDb();
    insert(db, { id: "p1", repo_full_name: "o/r", pull_number: 1, status: "complete", reviews_synced_at: "2026-01-01T00:00:00Z" });

    db.exec(migrationSql("0095_repair_reviews_synced_at.sql"));

    expect(() => db.exec(migrationSql("0095_repair_reviews_synced_at.sql"))).not.toThrow();
    expect(allRows(db).find((r) => r.id === "p1")?.reviews_synced_at).toBeNull();
  });
});
