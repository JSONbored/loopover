import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORB_EXPORT_ENABLED_BY_DEFAULT,
  DEFAULT_AMS_COLLECTOR_URL,
  amsInstanceId,
  buildAnonymizedOrbBatch,
  collectOrbExportBatch,
  filterBatchSinceCursor,
  hmacAnonymize,
  latestClosedAt,
  openOrbExportStore,
  resolveAmsCollectorUrl,
  sendAmsExportBatch,
} from "../../packages/gittensory-miner/lib/orb-export.js";
import type { OrbExportOutcome, OrbExportRow } from "../../packages/gittensory-miner/lib/orb-export.js";

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

describe("amsInstanceId (#5681)", () => {
  it("is deterministic per secret, 16 hex chars, and differs across secrets", () => {
    const id = amsInstanceId("a".repeat(64));
    expect(id).toBe(amsInstanceId("a".repeat(64)));
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(amsInstanceId("b".repeat(64))).not.toBe(id);
  });
});

describe("filterBatchSinceCursor / latestClosedAt (#5681)", () => {
  const row = (prHash: string, closedAt: string | null): OrbExportRow => ({ repoHash: "rh", prHash, decision: "merged", reasonBucket: "none", closedAt });

  it("returns everything when the cursor is null (first export)", () => {
    const batch = [row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-02T00:00:00Z")];
    expect(filterBatchSinceCursor(batch, null)).toEqual(batch);
  });

  it("drops rows at/before the cursor; keeps rows strictly after it", () => {
    const batch = [row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-02T00:00:00Z"), row("c", "2026-01-03T00:00:00Z")];
    expect(filterBatchSinceCursor(batch, "2026-01-02T00:00:00Z").map((r) => r.prHash)).toEqual(["c"]);
  });

  it("always keeps a row with no closedAt (defensive — no watermark to compare)", () => {
    const batch = [row("a", null)];
    expect(filterBatchSinceCursor(batch, "2099-01-01T00:00:00Z")).toEqual(batch);
  });

  it("latestClosedAt finds the max closedAt, ignoring nulls; null on an all-null/empty batch", () => {
    expect(latestClosedAt([row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-03T00:00:00Z"), row("c", null)])).toBe("2026-01-03T00:00:00Z");
    expect(latestClosedAt([row("a", null)])).toBeNull();
    expect(latestClosedAt([])).toBeNull();
  });
});

describe("resolveAmsCollectorUrl (#5681)", () => {
  it("defaults to gittensory's hosted collector; an explicit env var overrides it", () => {
    expect(resolveAmsCollectorUrl({})).toBe(DEFAULT_AMS_COLLECTOR_URL);
    expect(resolveAmsCollectorUrl({ GITTENSORY_MINER_AMS_COLLECTOR_URL: "  " })).toBe(DEFAULT_AMS_COLLECTOR_URL);
    expect(resolveAmsCollectorUrl({ GITTENSORY_MINER_AMS_COLLECTOR_URL: "https://example.test/ingest" })).toBe("https://example.test/ingest");
  });
});

describe("sendAmsExportBatch (#5681)", () => {
  const batch: OrbExportRow[] = [{ repoHash: "rh", prHash: "ph", decision: "merged", reasonBucket: "none", closedAt: "2026-01-01T00:00:00Z" }];

  it("returns { sent: 0 } without calling fetch for an empty batch", async () => {
    const fetchFn = vi.fn();
    expect(await sendAmsExportBatch({ batch: [], secret: "s".repeat(64), fetchFn })).toEqual({ sent: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs a signed, instance-tagged payload and reports sent on a 2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendAmsExportBatch({ batch, secret: "s".repeat(64), collectorUrl: "https://example.test/ingest", fetchFn });
    expect(result).toEqual({ sent: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/ingest");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ams-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-ams-instance"]).toBe(amsInstanceId("s".repeat(64)));
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ instanceId: amsInstanceId("s".repeat(64)), events: batch });
  });

  it("includes a bearer authorization header only when a collectorToken is provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await sendAmsExportBatch({ batch, secret: "s".repeat(64), collectorToken: "tok123", fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok123");
  });

  it("reports { sent: 0, error } on a non-2xx response, without throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    expect(await sendAmsExportBatch({ batch, secret: "s".repeat(64), fetchFn })).toEqual({ sent: 0, error: "http_503" });
  });

  it("reports { sent: 0, error } on a network failure, without throwing", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network_down"));
    const result = await sendAmsExportBatch({ batch, secret: "s".repeat(64), fetchFn });
    expect(result.sent).toBe(0);
    expect(result.error).toBeTruthy();
  });
});
