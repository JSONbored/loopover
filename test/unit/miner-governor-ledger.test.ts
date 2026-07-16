import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  appendGovernorEvent,
  closeDefaultGovernorLedger,
  initGovernorLedger,
  readGovernorEvents,
  resolveGovernorLedgerDbPath,
} from "../../packages/loopover-miner/lib/governor-ledger.js";
import { readSchemaVersion } from "../../packages/loopover-miner/lib/schema-version.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-ledger-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "nested", "governor-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultGovernorLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner governor ledger (#2328)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveGovernorLedgerDbPath({ LOOPOVER_MINER_GOVERNOR_LEDGER_DB: "/custom/g.sqlite3" })).toBe(
      "/custom/g.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/governor-ledger.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/loopover-miner/governor-ledger.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({})).toMatch(/\/\.config\/loopover-miner\/governor-ledger\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and reads empty before any append", () => {
    const ledger = tempLedger();
    expect(statSync(ledger.dbPath).mode & 0o077).toBe(0);
    expect(ledger.readGovernorEvents()).toEqual([]);
  });

  it("append-only round-trips every governor decision field", () => {
    const ledger = tempLedger();
    const entry = ledger.appendGovernorEvent({
      eventType: "denied",
      repoFullName: "JSONbored/gittensory",
      actionClass: "write",
      decision: "block",
      reason: "kill switch active",
      payload: { rule: "global_kill_switch" },
    });
    expect(entry).toMatchObject({
      id: 1,
      eventType: "denied",
      repoFullName: "JSONbored/gittensory",
      actionClass: "write",
      decision: "block",
      reason: "kill switch active",
      payload: { rule: "global_kill_switch" },
    });
    expect(ledger.readGovernorEvents()).toEqual([entry]);
    expect(ledger.readGovernorEvents({ repoFullName: "JSONbored/gittensory" })).toEqual([entry]);
    expect(ledger.readGovernorEvents({ repoFullName: "acme/other" })).toEqual([]);
  });

  it("rejects malformed events before insert and preserves insertion order", () => {
    const ledger = tempLedger();
    ledger.appendGovernorEvent({
      eventType: "allowed",
      actionClass: "analyze",
      decision: "allow",
      reason: "within budget",
    });
    expect(() =>
      ledger.appendGovernorEvent({
        eventType: "unknown",
        actionClass: "write",
        decision: "block",
        reason: "bad type",
      }),
    ).toThrow(/invalid_event_type/);
    expect(ledger.readGovernorEvents()).toHaveLength(1);
  });

  it("rejects invalid repo filter types before querying SQLite", () => {
    const ledger = tempLedger();
    expect(() => ledger.readGovernorEvents({ repoFullName: 42 as unknown as string })).toThrow(
      /invalid_repo_full_name/,
    );
  });

  it("rejects a corrupted payload blob on read instead of returning malformed data", () => {
    const ledger = tempLedger();
    ledger.appendGovernorEvent({
      eventType: "allowed",
      actionClass: "analyze",
      decision: "allow",
      reason: "ok",
    });
    const raw = new DatabaseSync(ledger.dbPath);
    raw.prepare("UPDATE governor_events SET payload_json = ? WHERE id = 1").run("{bad");
    raw.close();
    expect(() => ledger.readGovernorEvents()).toThrow("corrupted_governor_row");
  });

  it("records throttled and kill_switch outcomes for later audit", () => {
    const ledger = tempLedger();
    const throttled = ledger.appendGovernorEvent({
      eventType: "throttled",
      repoFullName: "acme/widgets",
      actionClass: "write",
      decision: "retry",
      reason: "local rate limit",
      payload: { retryAfterMs: 5000 },
    });
    const killSwitch = ledger.appendGovernorEvent({
      eventType: "kill_switch",
      actionClass: "write",
      decision: "block",
      reason: "operator halt",
    });
    expect(ledger.readGovernorEvents().map((row) => row.eventType)).toEqual(["throttled", "kill_switch"]);
    expect(throttled.payload).toEqual({ retryAfterMs: 5000 });
    expect(killSwitch.repoFullName).toBeNull();
  });

  describe("purgeByRepo (#5564)", () => {
    it("deletes every event for one repo and leaves other repos (and unscoped events) untouched", () => {
      const ledger = tempLedger();
      ledger.appendGovernorEvent({
        eventType: "denied",
        repoFullName: "acme/widgets",
        actionClass: "write",
        decision: "block",
        reason: "house rule",
      });
      ledger.appendGovernorEvent({
        eventType: "throttled",
        repoFullName: "acme/widgets",
        actionClass: "write",
        decision: "retry",
        reason: "rate limit",
      });
      ledger.appendGovernorEvent({
        eventType: "allowed",
        repoFullName: "acme/other",
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
      });
      ledger.appendGovernorEvent({
        eventType: "kill_switch",
        actionClass: "write",
        decision: "block",
        reason: "operator halt",
      });

      expect(ledger.purgeByRepo("acme/widgets")).toBe(2);
      expect(ledger.readGovernorEvents({ repoFullName: "acme/widgets" })).toEqual([]);
      expect(ledger.readGovernorEvents()).toHaveLength(2);
    });

    it("returns 0 when nothing matches the repo", () => {
      const ledger = tempLedger();
      ledger.appendGovernorEvent({
        eventType: "allowed",
        repoFullName: "acme/other",
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
      });
      expect(ledger.purgeByRepo("acme/widgets")).toBe(0);
      expect(ledger.readGovernorEvents()).toHaveLength(1);
    });

    it("rejects a missing/malformed repoFullName rather than silently no-opping", () => {
      const ledger = tempLedger();
      expect(() => ledger.purgeByRepo(undefined as never)).toThrow("invalid_repo_full_name");
      expect(() => ledger.purgeByRepo("no-slash")).toThrow("invalid_repo_full_name");
    });
  });

  it("uses the default singleton ledger helpers and closes cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-default-"));
    roots.push(root);
    const previousConfigDir = process.env.LOOPOVER_MINER_CONFIG_DIR;
    process.env.LOOPOVER_MINER_CONFIG_DIR = root;
    try {
      const entry = appendGovernorEvent({
        eventType: "allowed",
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
      });
      expect(readGovernorEvents()).toEqual([entry]);
      closeDefaultGovernorLedger();
      closeDefaultGovernorLedger();
    } finally {
      if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
      else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
    }
  });

  describe("schema migrations (#6597)", () => {
    it("v1 -> v2 (#4939/#6597): adds an additive tenant_id column, NULL for every pre-existing row -- self-host behavior byte-identical", () => {
      const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-legacy-v1-"));
      roots.push(root);
      const dbPath = join(root, "legacy-v1.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE governor_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          event_type TEXT NOT NULL,
          repo_full_name TEXT,
          action_class TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `);
      legacy.exec("CREATE INDEX idx_governor_events_repo ON governor_events (repo_full_name, id)");
      legacy.exec("PRAGMA user_version = 1");
      legacy.exec(
        "INSERT INTO governor_events (ts, event_type, repo_full_name, action_class, decision, reason, payload_json) VALUES ('2026-01-01T00:00:00.000Z', 'allowed', 'acme/widgets', 'analyze', 'allow', 'within budget', '{}')",
      );
      legacy.close();

      const ledger = initGovernorLedger(dbPath);
      ledgers.push(ledger);
      expect(ledger.readGovernorEvents().map((event) => event.eventType)).toEqual(["allowed"]);
      const readonly = new DatabaseSync(dbPath, { readOnly: true });
      const columns = readonly.prepare("PRAGMA table_info(governor_events)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("tenant_id");
      expect(readSchemaVersion(readonly)).toBe(2);
      const row = readonly.prepare("SELECT tenant_id FROM governor_events WHERE id = 1").get() as { tenant_id: string | null };
      expect(row.tenant_id).toBeNull();
      readonly.close();
    });

    it("REGRESSION: a v1 file that (unusually) already carries tenant_id is not re-altered into a duplicate-column error", () => {
      const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-legacy-partial-v2-"));
      roots.push(root);
      const dbPath = join(root, "legacy-partial-v2.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE governor_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          event_type TEXT NOT NULL,
          repo_full_name TEXT,
          action_class TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          tenant_id TEXT
        )
      `);
      legacy.exec("PRAGMA user_version = 1");
      legacy.close();

      expect(() => {
        const ledger = initGovernorLedger(dbPath);
        ledgers.push(ledger);
      }).not.toThrow();
    });

    it("opening a fresh store reports user_version = 2 via readSchemaVersion", () => {
      const ledger = tempLedger();
      const readonly = new DatabaseSync(ledger.dbPath, { readOnly: true });
      expect(readSchemaVersion(readonly)).toBe(2);
      readonly.close();
    });
  });
});
