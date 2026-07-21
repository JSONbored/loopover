import { describe, expect, it } from "vitest";
import { buildExportManifest, buildTableExport, checksumRows, EXCLUDED_TABLES, filterRowsSince, isSafeTableName, redactRow, REDACTED_COLUMNS } from "../../scripts/export-d1-core.js";

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

  it("redacts every DO-NOT-MIGRATE column", () => {
    expect(REDACTED_COLUMNS).toMatchObject({
      auth_sessions: ["token_hash"],
      webhook_events: ["payload_hash"],
      repository_ai_keys: ["ciphertext"],
      repository_linear_keys: ["ciphertext"],
      auth_session_github_tokens: ["ciphertext", "refresh_ciphertext"],
      submission_user_tokens: ["encrypted_token"],
      orb_enrollments: ["secret_hash", "relay_secret_enc", "relay_secret_iv", "relay_secret_salt", "cached_token_json"],
    });
    expect(redactRow("webhook_events", { delivery_id: "d1", payload_hash: "h" })).toEqual({ delivery_id: "d1" });
    expect(redactRow("repository_ai_keys", { repo_full_name: "o/r", ciphertext: "ENCRYPTED" })).toEqual({ repo_full_name: "o/r" });
  });

  // Schema isolates these ciphertext columns specifically so they are NEVER serialized (#6295). Keep an
  // explicit allowlist here rather than parsing schema comments (comment phrasing drifts); when a new
  // never-serialize ciphertext table lands, add it to both REDACTED_COLUMNS and this list.
  it("redacts every schema-isolated never-serialize ciphertext table", () => {
    const neverSerializeCiphertextColumns: Record<string, string[]> = {
      repository_ai_keys: ["ciphertext"],
      repository_linear_keys: ["ciphertext"],
      auth_session_github_tokens: ["ciphertext", "refresh_ciphertext"],
    };
    for (const [table, columns] of Object.entries(neverSerializeCiphertextColumns)) {
      expect(REDACTED_COLUMNS[table]).toEqual(columns);
    }

    const linearExport = buildTableExport("repository_linear_keys", [
      { repo_full_name: "o/r", ciphertext: "LEAK_LINEAR_CIPHERTEXT", iv: "iv", last4: "abcd" },
    ]);
    expect(linearExport?.redactedColumns).toEqual(["ciphertext"]);
    expect(linearExport?.rows).toEqual([{ repo_full_name: "o/r", iv: "iv", last4: "abcd" }]);

    const sessionTokenExport = buildTableExport("auth_session_github_tokens", [
      {
        session_id: "s1",
        ciphertext: "LEAK_SESSION_GITHUB_CIPHERTEXT",
        iv: "iv",
        refresh_ciphertext: "LEAK_SESSION_GITHUB_REFRESH_CIPHERTEXT",
        refresh_iv: "riv",
      },
    ]);
    expect(sessionTokenExport?.redactedColumns).toEqual(["ciphertext", "refresh_ciphertext"]);
    expect(sessionTokenExport?.rows).toEqual([{ session_id: "s1", iv: "iv", refresh_iv: "riv" }]);

    expect(JSON.stringify([linearExport, sessionTokenExport])).not.toMatch(/LEAK_/);
  });

  it("redacts draft OAuth and Orb secret material from self-host exports (regression)", () => {
    const draftExport = buildTableExport("submission_user_tokens", [
      { draft_id: "d1", encrypted_token: "LEAK_DRAFT_OAUTH_TOKEN_ENVELOPE", expires_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(draftExport?.redactedColumns).toEqual(["encrypted_token"]);
    expect(draftExport?.rows).toEqual([{ draft_id: "d1", expires_at: "2026-01-01T00:00:00Z" }]);

    const orbExport = buildTableExport("orb_enrollments", [
      {
        enroll_id: "e1",
        installation_id: 42,
        secret_hash: "LEAK_ORB_ENROLLMENT_SECRET_HASH",
        relay_secret_enc: "LEAK_RELAY_SECRET",
        relay_secret_iv: "LEAK_RELAY_IV",
        relay_secret_salt: "LEAK_RELAY_SALT",
        cached_token_json: "LEAK_CACHED_ORB_TOKEN_ENVELOPE",
      },
    ]);
    expect(orbExport?.redactedColumns).toEqual(["secret_hash", "relay_secret_enc", "relay_secret_iv", "relay_secret_salt", "cached_token_json"]);
    expect(orbExport?.rows).toEqual([{ enroll_id: "e1", installation_id: 42 }]);

    expect(JSON.stringify([draftExport, orbExport])).not.toMatch(/LEAK_/);
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

  it("excludes the private gate calibration ledger from self-host exports (regression)", () => {
    const out = buildTableExport("predicted_gate_calibration_ledger", [
      {
        login: "alice",
        project: "owner/repo",
        target_id: "owner/repo#1",
        predicted_action: "merge",
        real_decision: "hold",
        agreed: 0,
      },
    ]);

    expect(EXCLUDED_TABLES.has("predicted_gate_calibration_ledger")).toBe(true);
    expect(out).toBeNull();
  });

  it("excludes the login-keyed predicted-gate-calls ledger from self-host exports (regression)", () => {
    const out = buildTableExport("predicted_gate_calls", [
      {
        id: "1",
        login: "alice",
        project: "owner/repo",
        predicted_action: "merge",
        conclusion: "success",
        reason_code: null,
      },
    ]);

    expect(EXCLUDED_TABLES.has("predicted_gate_calls")).toBe(true);
    expect(out).toBeNull();
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
    const manifest = buildExportManifest(exports, { database: "loopover" });
    expect(manifest.database).toBe("loopover");
    expect(manifest.tableCount).toBe(2);
    expect(manifest.totalRows).toBe(3);
    expect(manifest.tables.map((t) => t.table).sort()).toEqual(["auth_sessions", "repositories"]);
    // The manifest carries metadata + checksums only — never the row payloads.
    expect(JSON.stringify(manifest)).not.toContain('"rows"');
  });
});
