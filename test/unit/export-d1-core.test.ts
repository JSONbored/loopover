import { describe, expect, it } from "vitest";
import { buildExportManifest, buildTableExport, checksumRows, EXCLUDED_TABLES, filterRowsSince, isSafeTableName, redactRow, REDACTED_COLUMNS } from "../../scripts/export-d1-core.mjs";

describe("export-d1-core isSafeTableName (SQL-injection guard)", () => {
  it("accepts plain SQL identifiers", () => {
    expect(isSafeTableName("repositories")).toBe(true);
    expect(isSafeTableName("auth_sessions")).toBe(true);
    expect(isSafeTableName("_internal9")).toBe(true);
  });

  it("rejects anything that could break out of a quoted identifier", () => {
    expect(isSafeTableName('repos"; DROP TABLE x;--')).toBe(false);
    expect(isSafeTableName("has space")).toBe(false);
    expect(isSafeTableName("9starts-with-digit")).toBe(false);
    expect(isSafeTableName("")).toBe(false);
    expect(isSafeTableName(undefined)).toBe(false);
    expect(isSafeTableName(123)).toBe(false);
  });
});

describe("export-d1-core redaction (#selfhost-migration)", () => {
  it("drops the sensitive column for a redacted table and never emits it", () => {
    const row = { id: 1, login: "a", token_hash: "SECRET-HASH", expires_at: "2026-01-01T00:00:00Z" };
    const safe = redactRow("auth_sessions", row);
    expect(safe).not.toHaveProperty("token_hash");
    expect(safe).toEqual({ id: 1, login: "a", expires_at: "2026-01-01T00:00:00Z" });
    expect(JSON.stringify(safe)).not.toContain("SECRET-HASH");
  });

  it("leaves a row from a non-redacted table untouched (same reference)", () => {
    const row = { id: 1, full_name: "owner/repo" };
    expect(redactRow("repositories", row)).toBe(row);
  });

  it("redacts every DO-NOT-MIGRATE column (token_hash / payload_hash / ciphertext)", () => {
    expect(REDACTED_COLUMNS).toMatchObject({ auth_sessions: ["token_hash"], webhook_events: ["payload_hash"], repository_ai_keys: ["ciphertext"] });
    expect(redactRow("webhook_events", { delivery_id: "d1", payload_hash: "h" })).toEqual({ delivery_id: "d1" });
    expect(redactRow("repository_ai_keys", { repo_full_name: "o/r", ciphertext: "ENCRYPTED" })).toEqual({ repo_full_name: "o/r" });
  });
});

describe("export-d1-core checksum", () => {
  it("is deterministic and column-order independent", () => {
    const a = [{ id: 1, name: "x" }, { id: 2, name: "y" }];
    const b = [{ name: "x", id: 1 }, { name: "y", id: 2 }]; // same data, different key order
    expect(checksumRows(a)).toBe(checksumRows(b));
  });

  it("changes when the data changes", () => {
    expect(checksumRows([{ id: 1 }])).not.toBe(checksumRows([{ id: 2 }]));
  });
});

describe("export-d1-core incremental filter", () => {
  const rows = [
    { id: 1, updated_at: "2026-05-01T00:00:00Z" },
    { id: 2, updated_at: "2026-06-15T00:00:00Z" },
    { id: 3 }, // missing the timestamp column
  ];

  it("keeps only rows at/after the since-date, and KEEPS rows missing the column (fail-safe)", () => {
    const kept = filterRowsSince(rows, "updated_at", "2026-06-01T00:00:00Z");
    expect(kept.map((r) => r.id)).toEqual([2, 3]);
  });

  it("returns every row when no since-date (full export) or no since-column", () => {
    expect(filterRowsSince(rows, "updated_at", undefined)).toHaveLength(3);
    expect(filterRowsSince(rows, undefined, "2026-06-01T00:00:00Z")).toHaveLength(3);
  });
});

describe("export-d1-core buildTableExport + manifest", () => {
  it("returns null for an excluded table so it is never written", () => {
    expect(EXCLUDED_TABLES.has("d1_migrations")).toBe(true);
    expect(buildTableExport("d1_migrations", [{ id: 1 }])).toBeNull();
  });

  it("redacts + checksums + counts rows for an exported table", () => {
    const out = buildTableExport("auth_sessions", [{ id: 1, token_hash: "h1" }, { id: 2, token_hash: "h2" }]);
    expect(out).not.toBeNull();
    expect(out?.rowCount).toBe(2);
    expect(out?.redactedColumns).toEqual(["token_hash"]);
    expect(JSON.stringify(out?.rows)).not.toContain("h1");
    expect(out?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies the incremental window through buildTableExport", () => {
    const out = buildTableExport("repositories", [{ id: 1, updated_at: "2026-05-01T00:00:00Z" }, { id: 2, updated_at: "2026-07-01T00:00:00Z" }], {
      sinceColumn: "updated_at",
      sinceDate: "2026-06-01T00:00:00Z",
    });
    expect(out?.rowCount).toBe(1);
    expect(out?.rows[0]).toMatchObject({ id: 2 });
  });

  it("builds a manifest that omits row payloads, sums rows, and drops excluded entries", () => {
    const exports = [
      buildTableExport("repositories", [{ id: 1 }, { id: 2 }]),
      buildTableExport("auth_sessions", [{ id: 9, token_hash: "h" }]),
      buildTableExport("d1_migrations", [{ id: 1 }]), // null → excluded
    ];
    const manifest = buildExportManifest(exports, { database: "gittensory" });
    expect(manifest.database).toBe("gittensory");
    expect(manifest.tableCount).toBe(2);
    expect(manifest.totalRows).toBe(3);
    expect(manifest.tables.map((t) => t.table).sort()).toEqual(["auth_sessions", "repositories"]);
    // The manifest carries metadata + checksums only — never the row payloads.
    expect(JSON.stringify(manifest)).not.toContain('"rows"');
  });
});
