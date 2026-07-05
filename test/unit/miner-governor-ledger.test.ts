import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  appendGovernorEvent,
  closeDefaultGovernorLedger,
  initGovernorLedger,
  readGovernorEvents,
  resolveGovernorLedgerDbPath,
} from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-ledger-"));
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

describe("gittensory-miner governor ledger (#2328)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveGovernorLedgerDbPath({ GITTENSORY_MINER_GOVERNOR_LEDGER_DB: "/custom/g.sqlite3" })).toBe(
      "/custom/g.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/governor-ledger.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/governor-ledger.sqlite3",
    );
    expect(resolveGovernorLedgerDbPath({})).toMatch(/\/\.config\/gittensory-miner\/governor-ledger\.sqlite3$/);
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

  it("uses the default singleton ledger helpers and closes cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-default-"));
    roots.push(root);
    const previousConfigDir = process.env.GITTENSORY_MINER_CONFIG_DIR;
    process.env.GITTENSORY_MINER_CONFIG_DIR = root;
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
      if (previousConfigDir === undefined) delete process.env.GITTENSORY_MINER_CONFIG_DIR;
      else process.env.GITTENSORY_MINER_CONFIG_DIR = previousConfigDir;
    }
  });
});
