import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// Regression coverage for migrations/0083, which normalizes digest_subscriptions login/email to lowercase and
// deduplicates rows that collide under the unique (login, email) index. The migration was rewritten off a
// CREATE TEMP TABLE (rejected by D1's remote authorizer with SQLITE_AUTH) onto a DELETE-then-UPDATE form; these
// tests pin the semantics — winner selection, case-normalization, and no unique-index violation — against the
// REAL migration file so a future edit that reorders the steps or changes the tie-break fails here.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const migrationSql = (name: string) => readFileSync(join(migrationsDir, name), "utf8");

type Row = { id: string; login: string; email: string; status: string };

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationSql("0014_digest_subscriptions.sql"));
  return db;
}

function insert(db: DatabaseSync, row: Omit<Row, "status"> & { status?: string; created_at: string; updated_at: string }): void {
  db.prepare(
    "INSERT INTO digest_subscriptions (id, login, email, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'app', ?, ?)",
  ).run(row.id, row.login, row.email, row.status ?? "active", row.created_at, row.updated_at);
}

function allRows(db: DatabaseSync): Row[] {
  return db.prepare("SELECT id, login, email, status FROM digest_subscriptions ORDER BY login, email").all() as Row[];
}

describe("0083 digest-subscription normalization migration", () => {
  it("keeps the newest row per case-insensitive (login, email) group and lowercases every survivor", () => {
    const db = freshDb();
    // One case-collision group (same lower(login)/lower(email), differing case + timestamps)...
    insert(db, { id: "a1", login: "Alice", email: "A@X.com", created_at: "2024-01-01", updated_at: "2024-01-01" }); // oldest loser
    insert(db, { id: "a2", login: "alice", email: "a@x.com", status: "paused", created_at: "2024-01-02", updated_at: "2024-01-05" }); // newest → survives
    insert(db, { id: "a3", login: "ALICE", email: "a@X.COM", created_at: "2024-01-03", updated_at: "2024-01-03" }); // middle loser
    // ...plus a mixed-case unique row and an already-lowercase unique row, both of which must survive.
    insert(db, { id: "b1", login: "Bob", email: "bob@y.com", created_at: "2024-01-01", updated_at: "2024-01-01" });
    insert(db, { id: "c1", login: "carol", email: "carol@z.com", created_at: "2024-01-01", updated_at: "2024-01-01" });

    db.exec(migrationSql("0083_normalize_digest_subscription_logins.sql"));

    const rows = allRows(db);
    // Collision group collapses to its newest member (a2); the two unique rows remain — 3 total.
    expect(rows.map((r) => r.id)).toEqual(["a2", "b1", "c1"]);
    // The survivor is row a2 verbatim (its own status), not a merge of the group's fields.
    expect(rows.find((r) => r.id === "a2")).toMatchObject({ login: "alice", email: "a@x.com", status: "paused" });
    // Every survivor is lowercased.
    expect(rows.every((r) => r.login === r.login.toLowerCase() && r.email === r.email.toLowerCase())).toBe(true);
    expect(rows.find((r) => r.id === "b1")).toMatchObject({ login: "bob", email: "bob@y.com" });
  });

  it("does not violate the unique index when a mixed-case row lowercases onto an existing lowercase sibling", () => {
    const db = freshDb();
    // Reversing the migration's delete/update order would make canonicalizing 'Dave' collide with the existing
    // 'dave' row mid-UPDATE. Delete-before-update keeps only the newest, so the UPDATE is collision-free.
    insert(db, { id: "d1", login: "dave", email: "d@e.com", created_at: "2024-01-01", updated_at: "2024-01-01" }); // older loser
    insert(db, { id: "d2", login: "Dave", email: "D@E.com", status: "paused", created_at: "2024-01-02", updated_at: "2024-01-02" }); // newer → survives

    expect(() => db.exec(migrationSql("0083_normalize_digest_subscription_logins.sql"))).not.toThrow();

    expect(allRows(db)).toEqual([{ id: "d2", login: "dave", email: "d@e.com", status: "paused" }]);
  });

  it("is a no-op on data that is already lowercase and collision-free", () => {
    const db = freshDb();
    insert(db, { id: "e1", login: "erin", email: "erin@f.com", created_at: "2024-01-01", updated_at: "2024-01-01" });
    insert(db, { id: "f1", login: "frank", email: "frank@g.com", created_at: "2024-01-01", updated_at: "2024-01-01" });

    db.exec(migrationSql("0083_normalize_digest_subscription_logins.sql"));

    expect(allRows(db)).toEqual([
      { id: "e1", login: "erin", email: "erin@f.com", status: "active" },
      { id: "f1", login: "frank", email: "frank@g.com", status: "active" },
    ]);
  });
});
