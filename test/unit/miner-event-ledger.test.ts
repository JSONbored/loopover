import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  closeDefaultEventLedger,
  initEventLedger,
  readEvents,
  resolveEventLedgerDbPath,
} from "../../packages/loopover-miner/lib/event-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-event-ledger-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "nested", "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultEventLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner event ledger (#2290)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveEventLedgerDbPath({ LOOPOVER_MINER_EVENT_LEDGER_DB: "/custom/e.sqlite3" })).toBe(
      "/custom/e.sqlite3",
    );
    expect(resolveEventLedgerDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/event-ledger.sqlite3",
    );
    expect(resolveEventLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/loopover-miner/event-ledger.sqlite3",
    );
    expect(resolveEventLedgerDbPath({})).toMatch(/\/\.config\/loopover-miner\/event-ledger\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and reads empty before any append", () => {
    const ledger = tempLedger();
    expect(statSync(ledger.dbPath).mode & 0o077).toBe(0);
    expect(ledger.readEvents()).toEqual([]);
  });

  it("appends an event and reads it back verbatim (JSON payload round-trip)", () => {
    const ledger = tempLedger();
    const entry = ledger.appendEvent({
      type: "discovered_issue",
      repoFullName: "JSONbored/loopover",
      payload: { issueNumber: 2290, labels: ["gittensor:feature"] },
    });
    expect(entry).toMatchObject({
      seq: 1,
      type: "discovered_issue",
      repoFullName: "JSONbored/loopover",
      payload: { issueNumber: 2290, labels: ["gittensor:feature"] },
    });
    expect(typeof entry.id).toBe("number");
    expect(typeof entry.createdAt).toBe("string");
    expect(ledger.readEvents()).toEqual([entry]);
  });

  it("stores a null repo scope when none is given", () => {
    const ledger = tempLedger();
    expect(ledger.appendEvent({ type: "plan_built", payload: { steps: 3 } }).repoFullName).toBeNull();
  });

  it("assigns a strictly monotonic, gapless, unique seq across many appends", () => {
    const ledger = tempLedger();
    for (let i = 0; i < 50; i += 1) ledger.appendEvent({ type: "discovered_issue", payload: { i } });
    const seqs = ledger.readEvents().map((entry) => entry.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_unused, i) => i + 1)); // 1..50, gapless
    expect(new Set(seqs).size).toBe(50); // all unique
  });

  it("filters by repoFullName", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/a", payload: {} });
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/b", payload: {} });
    ledger.appendEvent({ type: "plan_built", repoFullName: "o/a", payload: {} });
    expect(ledger.readEvents({ repoFullName: "o/a" }).map((entry) => entry.type)).toEqual([
      "discovered_issue",
      "plan_built",
    ]);
  });

  it("treats a null repo filter as unscoped and returns all events", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "plan_built", payload: {} });
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/a", payload: {} });
    ledger.appendEvent({ type: "pr_prepared", repoFullName: "o/b", payload: {} });
    const events = ledger.readEvents({ repoFullName: null });
    expect(events).toHaveLength(3);
    expect(events.map((entry) => entry.type)).toEqual(["plan_built", "discovered_issue", "pr_prepared"]);
  });

  it("treats a null since filter as unscoped", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", payload: {} }); // seq 1
    ledger.appendEvent({ type: "plan_built", payload: {} }); // seq 2
    expect(ledger.readEvents({ since: null }).map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("keeps a null repo filter unscoped when combined with since", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/a", payload: {} }); // seq 1
    ledger.appendEvent({ type: "plan_built", payload: {} }); // seq 2
    ledger.appendEvent({ type: "pr_prepared", repoFullName: "o/a", payload: {} }); // seq 3
    expect(ledger.readEvents({ repoFullName: null, since: 1 }).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("filters by `since` (strictly greater seq), and combines with repoFullName", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/a", payload: {} }); // seq 1
    ledger.appendEvent({ type: "plan_built", repoFullName: "o/b", payload: {} }); // seq 2
    ledger.appendEvent({ type: "pr_prepared", repoFullName: "o/a", payload: {} }); // seq 3
    expect(ledger.readEvents({ since: 1 }).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ledger.readEvents({ repoFullName: "o/a", since: 1 }).map((entry) => entry.seq)).toEqual([3]);
  });

  it("rejects a non-integer or non-finite since cursor rather than querying with it", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", payload: {} });
    expect(() => ledger.readEvents({ since: Number.NaN })).toThrow("invalid_since");
    expect(() => ledger.readEvents({ since: Number.POSITIVE_INFINITY })).toThrow("invalid_since");
    expect(() => ledger.readEvents({ since: -1 })).toThrow("invalid_since");
    expect(() => ledger.readEvents({ since: 1.5 })).toThrow("invalid_since");
  });

  it("rejects a non-object payload and a malformed repo scope rather than persisting them", () => {
    const ledger = tempLedger();
    // @ts-expect-error — payload must be an object
    expect(() => ledger.appendEvent({ type: "x", payload: "nope" })).toThrow("invalid_payload");
    expect(() => ledger.appendEvent({ type: "  ", payload: {} })).toThrow("invalid_event_type");
    // A non-string event type is rejected the same as an empty one, before any SQL runs.
    expect(() => ledger.appendEvent({ type: 42 as unknown as string, payload: {} })).toThrow("invalid_event_type");
    expect(() => ledger.appendEvent({ type: "x", repoFullName: "no-slash", payload: {} })).toThrow(
      "invalid_repo_full_name",
    );
    // A non-string (but non-nullish) repo scope is rejected too — distinct from the omitted/null "unscoped" case.
    expect(() => ledger.appendEvent({ type: "x", repoFullName: 42 as unknown as string, payload: {} })).toThrow(
      "invalid_repo_full_name",
    );
  });

  it("rejects a payload JSON would not round-trip verbatim, and accepts a nested JSON-safe one", () => {
    const ledger = tempLedger();
    // Values JSON drops or coerces would make the audit entry differ from what was appended.
    expect(() => ledger.appendEvent({ type: "x", payload: { a: undefined } })).toThrow("invalid_payload");
    expect(() => ledger.appendEvent({ type: "x", payload: { a: Number.NaN } })).toThrow("invalid_payload");
    expect(() => ledger.appendEvent({ type: "x", payload: { a: () => 1 } })).toThrow("invalid_payload");
    expect(() => ledger.appendEvent({ type: "x", payload: { a: [1, undefined] } })).toThrow("invalid_payload");
    // A payload JSON.stringify cannot even serialize (BigInt / a circular reference) fails closed the same way,
    // via the stringify try/catch rather than the round-trip equality check.
    expect(() => ledger.appendEvent({ type: "x", payload: { a: 1n } })).toThrow("invalid_payload");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => ledger.appendEvent({ type: "x", payload: circular })).toThrow("invalid_payload");
    // A fully JSON-safe nested payload is accepted and reads back identically.
    const entry = ledger.appendEvent({ type: "x", payload: { a: { b: [1, "two", true, null] } } });
    expect(ledger.readEvents()).toContainEqual(entry);
  });

  it("rolls back and rethrows when the append transaction hits a database error mid-flight", () => {
    const ledger = tempLedger();
    // Force a deterministic mid-transaction failure: drop the table out from under the open ledger via a separate
    // connection, so the in-transaction `MAX(seq)` read fails. appendEvent takes BEGIN IMMEDIATE before the try,
    // so the failure must ROLLBACK (never leave a dangling write transaction) and rethrow the underlying error.
    const raw = new DatabaseSync(ledger.dbPath);
    raw.exec("DROP TABLE miner_event_ledger");
    raw.close();
    expect(() => ledger.appendEvent({ type: "discovered_issue", payload: {} })).toThrow(/no such table/i);
    // afterEach then closes the handle cleanly, proving the failed append left no dangling write transaction.
  });

  it("uses the default singleton ledger helpers and closes cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-event-default-"));
    roots.push(root);
    const previousConfigDir = process.env.LOOPOVER_MINER_CONFIG_DIR;
    process.env.LOOPOVER_MINER_CONFIG_DIR = root;
    try {
      const entry = appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 1 } });
      expect(readEvents()).toEqual([entry]);
      // First close releases the real singleton; the second hits the already-closed no-op early return.
      closeDefaultEventLedger();
      closeDefaultEventLedger();
    } finally {
      if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
      else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
    }
  });

  it("is append-only: the module's own source issues no inline UPDATE or DELETE against the ledger (#5564: the sole exception, purgeByRepo, delegates its DELETE to store-maintenance.js's shared helper, never inline SQL here)", () => {
    const source = readFileSync("packages/loopover-miner/lib/event-ledger.js", "utf8");
    expect(source).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    expect(source).toContain("purgeByRepo");
  });

  describe("purgeByRepo (#5564)", () => {
    it("deletes every event for one repo and leaves other repos (and unscoped events) untouched", () => {
      const ledger = tempLedger();
      ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });
      ledger.appendEvent({ type: "plan_built", repoFullName: "acme/widgets", payload: {} });
      ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/other", payload: {} });
      ledger.appendEvent({ type: "plan_built", payload: {} }); // no repo scope

      expect(ledger.purgeByRepo("acme/widgets")).toBe(2);
      expect(ledger.readEvents({ repoFullName: "acme/widgets" })).toEqual([]);
      expect(ledger.readEvents()).toHaveLength(2);
    });

    it("returns 0 when nothing matches the repo", () => {
      const ledger = tempLedger();
      ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/other", payload: {} });
      expect(ledger.purgeByRepo("acme/widgets")).toBe(0);
      expect(ledger.readEvents()).toHaveLength(1);
    });

    it("rejects a missing/malformed repoFullName rather than silently no-opping", () => {
      const ledger = tempLedger();
      expect(() => ledger.purgeByRepo(undefined as never)).toThrow("invalid_repo_full_name");
      expect(() => ledger.purgeByRepo("no-slash")).toThrow("invalid_repo_full_name");
    });
  });

  describe("schema migrations", () => {
    it("v1 -> v2 (#4939): adds an additive tenant_id column, NULL for every pre-existing row -- self-host behavior byte-identical", () => {
      const root = mkdtempSync(join(tmpdir(), "loopover-miner-event-legacy-v1-"));
      roots.push(root);
      const dbPath = join(root, "legacy-v1.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE miner_event_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          seq INTEGER NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          repo_full_name TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      legacy.exec("PRAGMA user_version = 1");
      legacy.exec(
        "INSERT INTO miner_event_ledger (seq, event_type, repo_full_name, payload_json, created_at) VALUES (1, 'discovered_issue', 'acme/widgets', '{}', '2026-01-01T00:00:00.000Z')",
      );
      legacy.close();

      const ledger = initEventLedger(dbPath);
      ledgers.push(ledger);
      // The pre-existing row is untouched -- no consumer reads tenant_id yet, so it isn't part of the
      // public event shape; verified directly against the schema instead.
      expect(ledger.readEvents().map((event) => event.type)).toEqual(["discovered_issue"]);
      const readonly = new DatabaseSync(dbPath, { readOnly: true });
      const columns = readonly.prepare("PRAGMA table_info(miner_event_ledger)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("tenant_id");
      const row = readonly.prepare("SELECT tenant_id FROM miner_event_ledger WHERE seq = 1").get() as { tenant_id: string | null };
      expect(row.tenant_id).toBeNull();
      readonly.close();
    });

    it("REGRESSION: a v1 file that (unusually) already carries tenant_id is not re-altered into a duplicate-column error", () => {
      const root = mkdtempSync(join(tmpdir(), "loopover-miner-event-legacy-partial-v2-"));
      roots.push(root);
      const dbPath = join(root, "legacy-partial-v2.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE miner_event_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          seq INTEGER NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          repo_full_name TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tenant_id TEXT
        )
      `);
      legacy.exec("PRAGMA user_version = 1");
      legacy.close();

      expect(() => {
        const ledger = initEventLedger(dbPath);
        ledgers.push(ledger);
      }).not.toThrow();
    });
  });
});
