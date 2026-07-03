import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
  resolveEventLedgerDbPath,
} from "../../packages/gittensory-miner/lib/event-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-event-ledger-"));
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

describe("gittensory-miner event ledger (#2290)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveEventLedgerDbPath({ GITTENSORY_MINER_EVENT_LEDGER_DB: "/custom/e.sqlite3" })).toBe(
      "/custom/e.sqlite3",
    );
    expect(resolveEventLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/event-ledger.sqlite3",
    );
    expect(resolveEventLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/event-ledger.sqlite3",
    );
    expect(resolveEventLedgerDbPath({})).toMatch(/\/\.config\/gittensory-miner\/event-ledger\.sqlite3$/);
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
      repoFullName: "JSONbored/gittensory",
      payload: { issueNumber: 2290, labels: ["gittensor:feature"] },
    });
    expect(entry).toMatchObject({
      seq: 1,
      type: "discovered_issue",
      repoFullName: "JSONbored/gittensory",
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

  it("filters by `since` (strictly greater seq), and combines with repoFullName", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "o/a", payload: {} }); // seq 1
    ledger.appendEvent({ type: "plan_built", repoFullName: "o/b", payload: {} }); // seq 2
    ledger.appendEvent({ type: "pr_prepared", repoFullName: "o/a", payload: {} }); // seq 3
    expect(ledger.readEvents({ since: 1 }).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ledger.readEvents({ repoFullName: "o/a", since: 1 }).map((entry) => entry.seq)).toEqual([3]);
  });

  it("rejects a non-object payload and a malformed repo scope rather than persisting them", () => {
    const ledger = tempLedger();
    // @ts-expect-error — payload must be an object
    expect(() => ledger.appendEvent({ type: "x", payload: "nope" })).toThrow("invalid_payload");
    expect(() => ledger.appendEvent({ type: "  ", payload: {} })).toThrow("invalid_event_type");
    expect(() => ledger.appendEvent({ type: "x", repoFullName: "no-slash", payload: {} })).toThrow(
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
    // A fully JSON-safe nested payload is accepted and reads back identically.
    const entry = ledger.appendEvent({ type: "x", payload: { a: { b: [1, "two", true, null] } } });
    expect(ledger.readEvents()).toContainEqual(entry);
  });

  it("is append-only: the module source issues no UPDATE or DELETE against the ledger", () => {
    const source = readFileSync("packages/gittensory-miner/lib/event-ledger.js", "utf8");
    expect(source).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });
});
