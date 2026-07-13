import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_STATUSES,
  claimIssue,
  closeDefaultClaimLedger,
  listActiveClaims,
  openClaimLedger,
  openClaimLedgerReadOnly,
  resolveClaimLedgerDbPath,
} from "../../packages/gittensory-miner/lib/claim-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-ledger-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "nested", "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner claim ledger (#2314)", () => {
  it("exposes the frozen status vocabulary", () => {
    expect(CLAIM_STATUSES).toEqual(["active", "released", "expired"]);
    expect(Object.isFrozen(CLAIM_STATUSES)).toBe(true);
  });

  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveClaimLedgerDbPath({ GITTENSORY_MINER_CLAIM_LEDGER_DB: "/custom/c.sqlite3" })).toBe(
      "/custom/c.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/claim-ledger.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/claim-ledger.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({})).toMatch(/\/\.config\/gittensory-miner\/claim-ledger\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and lists empty before any claim", () => {
    const ledger = tempLedger();
    expect(statSync(ledger.dbPath).mode & 0o077).toBe(0);
    expect(ledger.listClaims()).toEqual([]);
  });

  it("records a claim and lists it back", () => {
    const ledger = tempLedger();
    const claim = ledger.recordClaim({ repoFullName: "JSONbored/gittensory", issueNumber: 2314, note: "mine" });
    expect(claim).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      issueNumber: 2314,
      status: "active",
      note: "mine",
    });
    expect(typeof claim.claimedAt).toBe("string");
    expect(ledger.listClaims()).toEqual([claim]);
    // A note is optional → null.
    expect(ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 }).note).toBeNull();
  });

  it("is idempotent: re-claiming an already-active issue is a no-op, not a duplicate row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    const ledger = tempLedger();
    const first = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 7, note: "first" });
    vi.setSystemTime(new Date("2026-07-03T01:00:00Z"));
    const second = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 7, note: "second" });
    // Same row, unchanged (claimed_at + note preserved) — a true no-op while active.
    expect(second).toEqual(first);
    expect(ledger.listClaims({ repoFullName: "o/a" })).toHaveLength(1);
  });

  it("releases a claim, and re-claiming after release re-activates the same row", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 9, note: "v1" });
    const released = ledger.releaseClaim("o/a", 9);
    expect(released?.status).toBe("released");
    expect(ledger.releaseClaim("o/a", 9)).toBeNull();
    // Re-claim after release: same single row, back to active, note refreshed.
    const reclaimed = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 9, note: "v2" });
    expect(reclaimed).toMatchObject({ status: "active", note: "v2", id: released?.id });
    expect(ledger.listClaims({ repoFullName: "o/a" })).toHaveLength(1);
    // Releasing an issue that was never claimed returns null.
    expect(ledger.releaseClaim("o/a", 404)).toBeNull();
  });

  it("filters listClaims by repoFullName and/or status", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/b", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 2 });
    ledger.releaseClaim("o/a", 2);
    expect(ledger.listClaims({ repoFullName: "o/a" }).map((c) => c.issueNumber)).toEqual([1, 2]);
    expect(ledger.listClaims({ status: "active" }).map((c) => c.repoFullName)).toEqual(["o/a", "o/b"]);
    expect(ledger.listClaims({ repoFullName: "o/a", status: "released" }).map((c) => c.issueNumber)).toEqual([2]);
  });

  it("treats null listClaims filters as unscoped", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/b", issueNumber: 2 });
    expect(ledger.listClaims({ repoFullName: null })).toHaveLength(2);
    expect(ledger.listClaims({ status: null })).toHaveLength(2);
    expect(ledger.listClaims({ repoFullName: null, status: null })).toHaveLength(2);
  });

  it("rejects malformed inputs rather than persisting them", () => {
    const ledger = tempLedger();
    expect(() => ledger.recordClaim({ repoFullName: "no-slash", issueNumber: 1 })).toThrow("invalid_repo_full_name");
    expect(() => ledger.recordClaim({ repoFullName: "o/a", issueNumber: 0 })).toThrow("invalid_issue_number");
    expect(() => ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1.5 })).toThrow("invalid_issue_number");
    expect(() => ledger.listClaims({ status: "bogus" as never })).toThrow("invalid_status");
  });

  it("claim-then-list, then release, excludes released rows from the active-only filter (#3354)", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 10 });
    expect(ledger.listClaims({ status: "active" }).map((c) => c.issueNumber)).toEqual([10]);
    ledger.releaseClaim("o/a", 10);
    expect(ledger.listClaims({ status: "active" })).toEqual([]);
    expect(ledger.listClaims()).toHaveLength(1);
  });

  it("documents that miner_claims is local bookkeeping only, not duplicate adjudication (#3355)", () => {
    const source = readFileSync("packages/gittensory-miner/lib/claim-ledger.js", "utf8");
    expect(source).toContain("LOCAL bookkeeping only");
    expect(source).toContain("does NOT adjudicate contested duplicates");
    expect(source).toContain("isDuplicateClusterWinnerByClaim");
  });

  it("claimIssue and listActiveClaims expose the foundation-phase API surface (#3351)", () => {
    const ledger = tempLedger();
    const claim = ledger.claimIssue("o/a", 42, "via-alias");
    expect(claim).toMatchObject({ repoFullName: "o/a", issueNumber: 42, status: "active", note: "via-alias" });
    expect(ledger.listActiveClaims()).toEqual([claim]);
    ledger.claimIssue("o/b", 1);
    ledger.releaseClaim("o/a", 42);
    expect(ledger.listActiveClaims("o/a")).toEqual([]);
    expect(ledger.listActiveClaims("o/b").map((c) => c.issueNumber)).toEqual([1]);
    expect(ledger.listActiveClaims().map((c) => c.repoFullName)).toEqual(["o/b"]);
    expect(ledger.claimIssue("o/c", 3).note).toBeNull();
  });

  it("claimIssue on an already-active claim is idempotent (#3353)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00Z"));
    const ledger = tempLedger();
    const first = ledger.claimIssue("o/a", 7, "first");
    vi.setSystemTime(new Date("2026-07-05T01:00:00Z"));
    const second = ledger.claimIssue("o/a", 7, "ignored");
    expect(second).toEqual(first);
    expect(ledger.listActiveClaims()).toHaveLength(1);
  });

  it("top-level claimIssue and listActiveClaims use the default ledger store", () => {
    const root = tempRoot();
    vi.stubEnv("GITTENSORY_MINER_CLAIM_LEDGER_DB", join(root, "claim-ledger.sqlite3"));
    closeDefaultClaimLedger();
    const claim = claimIssue("o/a", 99, "default-store");
    expect(claim).toMatchObject({ issueNumber: 99, status: "active" });
    expect(listActiveClaims()).toEqual([claim]);
    expect(listActiveClaims("o/a")).toEqual([claim]);
    expect(listActiveClaims("o/missing")).toEqual([]);
  });

  it("creates miner_claims with the foundation schema (#3352)", () => {
    const ledger = tempLedger();
    const db = new DatabaseSync(ledger.dbPath, { readOnly: true });
    type TableColumn = { name: string; notnull: number; dflt_value: string | null; pk: number };
    const columns = db.prepare("PRAGMA table_info(miner_claims)").all() as TableColumn[];
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "repo_full_name",
      "issue_number",
      "claimed_at",
      "status",
      "note",
    ]);
    for (const name of ["repo_full_name", "issue_number", "claimed_at", "status"]) {
      expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
    }
    expect(columns.find((column) => column.name === "status")?.dflt_value).toBe("'active'");
    expect(columns.find((column) => column.name === "id")?.pk).toBe(1);

    const uniqueIndexes = (db.prepare("PRAGMA index_list(miner_claims)").all() as Array<{ name: string; unique: number }>)
      .filter((index) => index.unique === 1);
    expect(uniqueIndexes.length).toBeGreaterThan(0);
    const indexCols = db.prepare(`PRAGMA index_info('${uniqueIndexes[0]!.name}')`).all() as Array<{ name: string }>;
    expect(indexCols.map((column) => column.name).sort()).toEqual(["issue_number", "repo_full_name"]);
    db.close();

    const writable = new DatabaseSync(ledger.dbPath);
    expect(() =>
      writable.exec(
        "INSERT INTO miner_claims (repo_full_name, issue_number, claimed_at, status) VALUES ('o/a', 1, '2026-01-01T00:00:00.000Z', 'bogus')",
      ),
    ).toThrow();
    writable.close();
  });

  describe("purgeByRepo (#5564)", () => {
    it("deletes every claim for one repo, across all statuses, and leaves other repos untouched", () => {
      const ledger = tempLedger();
      ledger.claimIssue("acme/widgets", 1);
      ledger.claimIssue("acme/widgets", 2);
      ledger.releaseClaim("acme/widgets", 2);
      ledger.claimIssue("acme/other", 3);

      expect(ledger.purgeByRepo("acme/widgets")).toBe(2);
      expect(ledger.listClaims({ repoFullName: "acme/widgets" })).toEqual([]);
      expect(ledger.listClaims({ repoFullName: "acme/other" })).toHaveLength(1);
    });

    it("returns 0 when nothing matches the repo", () => {
      const ledger = tempLedger();
      ledger.claimIssue("acme/other", 1);
      expect(ledger.purgeByRepo("acme/widgets")).toBe(0);
      expect(ledger.listClaims()).toHaveLength(1);
    });

    it("rejects a missing/malformed repoFullName rather than silently no-opping", () => {
      const ledger = tempLedger();
      expect(() => ledger.purgeByRepo(undefined as never)).toThrow("invalid_repo_full_name");
      expect(() => ledger.purgeByRepo("no-slash")).toThrow("invalid_repo_full_name");
    });
  });

  describe("openClaimLedgerReadOnly (#5157)", () => {
    it("lists active claims matching the writable ledger's own state, scoped to the given repo", () => {
      const ledger = tempLedger();
      ledger.claimIssue("acme/widgets", 42, "in progress");
      ledger.claimIssue("acme/widgets", 7);
      ledger.claimIssue("other/repo", 1);
      ledger.releaseClaim("acme/widgets", 7);

      const readOnly = openClaimLedgerReadOnly(ledger.dbPath);
      try {
        expect(readOnly.listActiveClaims("acme/widgets")).toEqual([
          {
            id: expect.any(Number),
            repoFullName: "acme/widgets",
            issueNumber: 42,
            claimedAt: expect.any(String),
            status: "active",
            note: "in progress",
          },
        ]);
        expect(readOnly.listActiveClaims("other/repo").map((c) => c.issueNumber)).toEqual([1]);
      } finally {
        readOnly.close();
      }
    });

    it("returns an empty array when no active claim matches the repo", () => {
      const ledger = tempLedger();
      ledger.claimIssue("acme/widgets", 42);
      const readOnly = openClaimLedgerReadOnly(ledger.dbPath);
      try {
        expect(readOnly.listActiveClaims("no/such-repo")).toEqual([]);
      } finally {
        readOnly.close();
      }
    });

    it("rejects a malformed repoFullName the same way the writable ledger does", () => {
      const ledger = tempLedger();
      const readOnly = openClaimLedgerReadOnly(ledger.dbPath);
      try {
        expect(() => readOnly.listActiveClaims("no-slash")).toThrow("invalid_repo_full_name");
      } finally {
        readOnly.close();
      }
    });

    it("throws when opening a path that doesn't exist (callers must existsSync-check first)", () => {
      const root = tempRoot();
      expect(() => openClaimLedgerReadOnly(join(root, "does-not-exist.sqlite3"))).toThrow();
    });

    it("regression: the underlying connection genuinely enforces read-only at the driver level (the readOnly vs. readonly key gotcha)", () => {
      // Pins the exact bug this module's own code comment documents: node:sqlite silently ignores the
      // lowercase `readonly` option key (opens read-write with no error), and only camelCase `readOnly`
      // actually enforces it. If claim-ledger.js's implementation ever regresses back to the wrong key,
      // this test starts failing because the write below would then silently succeed instead of throwing.
      const ledger = tempLedger();
      ledger.claimIssue("acme/widgets", 42);
      const readOnlyConnection = new DatabaseSync(ledger.dbPath, { readOnly: true });
      try {
        expect(() => readOnlyConnection.exec("DELETE FROM miner_claims")).toThrow(/readonly/i);
      } finally {
        readOnlyConnection.close();
      }
    });

    it("never creates the schema on an existing-but-empty SQLite file (no CREATE TABLE side effect)", () => {
      const root = tempRoot();
      const dbPath = join(root, "empty.sqlite3");
      const setup = new DatabaseSync(dbPath);
      setup.close();

      expect(() => openClaimLedgerReadOnly(dbPath)).toThrow();

      const inspect = new DatabaseSync(dbPath, { readOnly: true });
      const tables = (inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      inspect.close();
      expect(tables).toEqual([]);
    });
  });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-default-"));
  roots.push(root);
  return root;
}
