import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ORB_EXPORT_ENABLED_BY_DEFAULT,
  buildAnonymizedOrbBatch,
  collectOrbExportBatch,
  hmacAnonymize,
  openOrbExportStore,
} from "../../packages/gittensory-miner/lib/orb-export.js";
import type { OrbExportOutcome } from "../../packages/gittensory-miner/lib/orb-export.js";

let dir: string;
function storePath() {
  return join(dir, "orb-export.sqlite3");
}

/** A minimal in-memory event ledger of pr_outcome events, matching pr-outcome.js's readEvents contract. */
function fakeLedger(events: Array<{ type: string; repoFullName: string; payload: unknown }>) {
  return { readEvents: () => events };
}
function outcomeEvent(repoFullName: string, prNumber: number, decision: "merged" | "closed", reason: string | null) {
  return { type: "pr_outcome", repoFullName, payload: { prNumber, decision, closedAt: "2026-01-01T00:00:00Z", reason } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orb-export-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("orb-export store (#4277)", () => {
  it("defaults to opt-OUT (export disabled unless explicitly enabled)", () => {
    expect(ORB_EXPORT_ENABLED_BY_DEFAULT).toBe(false);
  });

  it("generates a stable 256-bit per-instance anon key and persists it across reopens", () => {
    const store = openOrbExportStore(storePath());
    const anonKey = store.getOrCreateAnonSecret();
    expect(anonKey).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getOrCreateAnonSecret()).toBe(anonKey); // same within a session
    store.close();

    const reopened = openOrbExportStore(storePath());
    expect(reopened.getOrCreateAnonSecret()).toBe(anonKey); // same across reopens
    reopened.close();
  });

  it("tracks an export cursor (null until set)", () => {
    const store = openOrbExportStore(storePath());
    expect(store.getCursor()).toBeNull();
    store.setCursor("2026-01-02T00:00:00Z");
    expect(store.getCursor()).toBe("2026-01-02T00:00:00Z");
    store.close();
  });
});

describe("hmacAnonymize", () => {
  const anonKey = "a".repeat(64);

  it("is deterministic per (value, key), hides the raw value, and separates distinct values", () => {
    const hashed = hmacAnonymize("owner/repo", anonKey);
    expect(hashed).toBe(hmacAnonymize("owner/repo", anonKey));
    expect(hashed).toMatch(/^[0-9a-f]{24}$/);
    expect(hashed).not.toContain("owner");
    expect(hmacAnonymize("owner/other", anonKey)).not.toBe(hashed);
    expect(hmacAnonymize("owner/repo", "b".repeat(64))).not.toBe(hashed); // different key → different hash
  });

  it("throws on a missing key", () => {
    expect(() => hmacAnonymize("owner/repo", "")).toThrow(/invalid_anon_secret/);
  });
});

describe("buildAnonymizedOrbBatch", () => {
  const anonKey = "c".repeat(64);

  it("anonymizes a readPrOutcomes-shaped map, buckets a null reason to 'none', and sorts deterministically", () => {
    const outcomes = new Map<string, OrbExportOutcome>([
      ["owner/repo:2", { repoFullName: "owner/repo", prNumber: 2, decision: "closed", closedAt: "2026-01-02T00:00:00Z", reason: "gate_close" }],
      ["owner/repo:1", { repoFullName: "owner/repo", prNumber: 1, decision: "merged", closedAt: null, reason: null }],
    ]);
    const batch = buildAnonymizedOrbBatch(outcomes, anonKey);
    expect(batch).toHaveLength(2);
    // no raw identifiers leak
    const json = JSON.stringify(batch);
    expect(json).not.toContain("owner/repo");
    expect(json).not.toContain('"prNumber"');
    const merged = batch.find((r) => r.decision === "merged");
    expect(merged?.reasonBucket).toBe("none");
    expect(merged?.closedAt).toBeNull();
    expect(merged?.repoHash).toBe(hmacAnonymize("owner/repo", anonKey));
    const closed = batch.find((r) => r.decision === "closed");
    expect(closed?.reasonBucket).toBe("gate_close");
    // deterministic prHash ordering
    expect([...batch].sort((a, b) => a.prHash.localeCompare(b.prHash))).toEqual(batch);
  });

  it("skips malformed outcome records", () => {
    const batch = buildAnonymizedOrbBatch(
      [
        null,
        { repoFullName: "owner/repo", prNumber: 1.5, decision: "merged", reason: null, closedAt: null },
        { repoFullName: "", prNumber: 1, decision: "merged", reason: null, closedAt: null },
      ] as never,
      anonKey,
    );
    expect(batch).toEqual([]);
  });
});

describe("collectOrbExportBatch", () => {
  it("returns null when export is not enabled (opt-in gate)", () => {
    const store = openOrbExportStore(storePath());
    expect(collectOrbExportBatch({ store, eventLedger: fakeLedger([]), enabled: false })).toBeNull();
    // default (no `enabled`) is also opt-out
    expect(collectOrbExportBatch({ store, eventLedger: fakeLedger([]) })).toBeNull();
    store.close();
  });

  it("builds an anonymized batch from the local pr_outcome ledger when enabled", () => {
    const store = openOrbExportStore(storePath());
    const ledger = fakeLedger([
      outcomeEvent("owner/a", 1, "merged", null),
      outcomeEvent("owner/b", 2, "closed", "superseded_by_duplicate"),
    ]);
    const batch = collectOrbExportBatch({ store, eventLedger: ledger, enabled: true });
    expect(batch).not.toBeNull();
    expect(batch).toHaveLength(2);
    expect(JSON.stringify(batch)).not.toContain("owner/");
    store.close();
  });

  it("throws on an invalid store", () => {
    expect(() =>
      collectOrbExportBatch({ store: {} as never, eventLedger: fakeLedger([]), enabled: true }),
    ).toThrow(/invalid_orb_export_store/);
  });
});
