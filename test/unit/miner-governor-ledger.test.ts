import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultGovernorLedger,
  initGovernorLedger,
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
    expect(ledger.readEvents()).toEqual([]);
  });

  it("appends a governor event and reads it back verbatim (JSON payload round-trip)", () => {
    const ledger = tempLedger();
    const entry = ledger.appendEvent({
      type: "denied",
      repoFullName: "JSONbored/gittensory",
      actionClass: "rate_limit",
      decision: "denied",
      reason: "over daily neuron budget",
      payload: { tokensRequested: 12000, tokensRemaining: 8000 },
    });
    expect(entry).toMatchObject({
      seq: 1,
      type: "denied",
      repoFullName: "JSONbored/gittensory",
      actionClass: "rate_limit",
      decision: "denied",
      reason: "over daily neuron budget",
      payload: { tokensRequested: 12000, tokensRemaining: 8000 },
    });
    expect(typeof entry.id).toBe("number");
    expect(typeof entry.ts).toBe("string");
    expect(ledger.readEvents()).toEqual([entry]);
  });

  it("accepts every documented governor event type and decision", () => {
    const ledger = tempLedger();
    const types = ["allowed", "denied", "throttled", "kill_switch_tripped"] as const;
    for (const type of types) {
      const entry = ledger.appendEvent({ type, decision: type, payload: { tag: type } });
      expect(entry.type).toBe(type);
      expect(entry.decision).toBe(type);
    }
    expect(ledger.readEvents().map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("stores null for the optional repoFullName, actionClass, decision, and reason fields", () => {
    const ledger = tempLedger();
    const entry = ledger.appendEvent({ type: "kill_switch_tripped", payload: {} });
    expect(entry.repoFullName).toBeNull();
    expect(entry.actionClass).toBeNull();
    expect(entry.decision).toBeNull();
    expect(entry.reason).toBeNull();
  });

  it("assigns a strictly monotonic, gapless, unique seq across many appends", () => {
    const ledger = tempLedger();
    for (let i = 0; i < 50; i += 1) ledger.appendEvent({ type: "allowed", payload: { i } });
    const seqs = ledger.readEvents().map((entry) => entry.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_unused, i) => i + 1));
    expect(new Set(seqs).size).toBe(50);
  });

  it("filters by repoFullName", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "denied", repoFullName: "o/a", payload: {} });
    ledger.appendEvent({ type: "denied", repoFullName: "o/b", payload: {} });
    ledger.appendEvent({ type: "allowed", repoFullName: "o/a", payload: {} });
    expect(ledger.readEvents({ repoFullName: "o/a" }).map((entry) => entry.type)).toEqual([
      "denied",
      "allowed",
    ]);
  });

  it("filters by `since` (strictly greater seq), and combines with repoFullName", () => {
    const ledger = tempLedger();
    ledger.appendEvent({ type: "denied", repoFullName: "o/a", payload: {} });
    ledger.appendEvent({ type: "allowed", repoFullName: "o/b", payload: {} });
    ledger.appendEvent({ type: "throttled", repoFullName: "o/a", payload: {} });
    expect(ledger.readEvents({ since: 1 }).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ledger.readEvents({ repoFullName: "o/a", since: 1 }).map((entry) => entry.seq)).toEqual([3]);
  });

  it("rejects malformed event types, decisions, and repo scopes rather than persisting them", () => {
    const ledger = tempLedger();
    // @ts-expect-error — unknown event type must be rejected before persist
    expect(() => ledger.appendEvent({ type: "exploded", payload: {} })).toThrow(
      "invalid_governor_event_type",
    );
    // @ts-expect-error — blank event type must be rejected before persist
    expect(() => ledger.appendEvent({ type: "  ", payload: {} })).toThrow(
      "invalid_governor_event_type",
    );
    // @ts-expect-error — unknown decision must be rejected before persist
    expect(() => ledger.appendEvent({ type: "allowed", decision: "exploded", payload: {} })).toThrow(
      "invalid_decision",
    );
    expect(() => ledger.appendEvent({ type: "allowed", repoFullName: "no-slash", payload: {} })).toThrow(
      "invalid_repo_full_name",
    );
  });

  it("rejects a payload JSON would not round-trip verbatim, and accepts a nested JSON-safe one", () => {
    const ledger = tempLedger();
    expect(() => ledger.appendEvent({ type: "allowed", payload: { a: undefined } })).toThrow(
      "invalid_payload",
    );
    expect(() => ledger.appendEvent({ type: "allowed", payload: { a: Number.NaN } })).toThrow(
      "invalid_payload",
    );
    expect(() => ledger.appendEvent({ type: "allowed", payload: { a: () => 1 } })).toThrow(
      "invalid_payload",
    );
    expect(() => ledger.appendEvent({ type: "allowed", payload: { a: [1, undefined] } })).toThrow(
      "invalid_payload",
    );
    const entry = ledger.appendEvent({ type: "allowed", payload: { a: { b: [1, "two", true, null] } } });
    expect(ledger.readEvents()).toContainEqual(entry);
  });

  it("is append-only: the module source issues no UPDATE or DELETE against the ledger", () => {
    const source = readFileSync("packages/gittensory-miner/lib/governor-ledger.js", "utf8");
    expect(source).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });
});