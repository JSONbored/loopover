import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExportManifest,
  buildTableExport,
  checksumRows,
  EXCLUDED_TABLES,
  EXPORT_REVIEWED_NON_SECRET_COLUMNS,
  filterRowsSince,
  isSafeTableName,
  redactRow,
  REDACTED_COLUMNS,
} from "../../scripts/export-d1-core";

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
      orb_webhook_events: ["payload_hash"],
      repository_ai_keys: ["ciphertext"],
      repository_linear_keys: ["ciphertext"],
      provider_credentials: ["ciphertext", "iv", "salt"],
      auth_session_github_tokens: ["ciphertext", "refresh_ciphertext"],
      submission_user_tokens: ["encrypted_token"],
      orb_enrollments: [
        "secret_hash",
        "relay_secret_enc",
        "relay_secret_iv",
        "relay_secret_salt",
        "cached_token_json",
        "secret_value_ciphertext",
        "secret_value_iv",
        "secret_value_salt",
      ],
      orb_instances: ["ingest_secret_hash"],
    });
    expect(redactRow("webhook_events", { delivery_id: "d1", payload_hash: "h" })).toEqual({ delivery_id: "d1" });
    expect(redactRow("repository_ai_keys", { repo_full_name: "o/r", ciphertext: "ENCRYPTED" })).toEqual({ repo_full_name: "o/r" });
  });

  // #9651: four secret-bearing column families added since the DO-NOT-MIGRATE list was last touched. redactRow
  // must drop each named column so no envelope/hash reaches the emitted export.
  it("redacts the four column families that drifted out of the list (#9651)", () => {
    const enrollment = redactRow("orb_enrollments", {
      enroll_id: "e1",
      secret_value_ciphertext: "LEAK_SECRET_VALUE_CIPHERTEXT",
      secret_value_iv: "LEAK_SECRET_VALUE_IV",
      secret_value_salt: "LEAK_SECRET_VALUE_SALT",
      secret_value_version: 1,
    });
    expect(enrollment).not.toHaveProperty("secret_value_ciphertext");
    expect(enrollment).not.toHaveProperty("secret_value_iv");
    expect(enrollment).not.toHaveProperty("secret_value_salt");
    expect(enrollment).toEqual({ enroll_id: "e1", secret_value_version: 1 });

    const provider = redactRow("provider_credentials", { provider: "anthropic", ciphertext: "LEAK_PROVIDER_CIPHERTEXT", iv: "LEAK_IV", salt: "LEAK_SALT", last4: "abcd" });
    expect(provider).not.toHaveProperty("ciphertext");
    expect(provider).not.toHaveProperty("iv");
    expect(provider).not.toHaveProperty("salt");
    expect(provider).toEqual({ provider: "anthropic", last4: "abcd" });

    const instance = redactRow("orb_instances", { instance_id: "i1", ingest_secret_hash: "LEAK_INGEST_SECRET_HASH" });
    expect(instance).not.toHaveProperty("ingest_secret_hash");
    expect(instance).toEqual({ instance_id: "i1" });

    const orbWebhook = redactRow("orb_webhook_events", { delivery_id: "d1", payload_hash: "LEAK_ORB_PAYLOAD_HASH" });
    expect(orbWebhook).not.toHaveProperty("payload_hash");
    expect(orbWebhook).toEqual({ delivery_id: "d1" });

    expect(JSON.stringify([enrollment, provider, instance, orbWebhook])).not.toMatch(/LEAK_/);
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
    expect(orbExport?.redactedColumns).toEqual([
      "secret_hash",
      "relay_secret_enc",
      "relay_secret_iv",
      "relay_secret_salt",
      "cached_token_json",
      "secret_value_ciphertext",
      "secret_value_iv",
      "secret_value_salt",
    ]);
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

// #9651 drift guard: #6295 added two missing ciphertext columns to the redaction list and nothing else — no
// mechanism — so the list drifted again across four migrations (orb_enrollments.secret_value_*,
// provider_credentials.*, orb_instances.ingest_secret_hash, orb_webhook_events.payload_hash). These tests are
// that mechanism: mirroring retention.test.ts's "read the real migrations/ from disk and diff two derived sets"
// pattern, every column across migrations/** whose NAME matches the sensitive pattern must be classified as
// either redacted or explicitly-reviewed-non-secret, so a future secret column fails the suite until triaged.
const SENSITIVE_COLUMN = /ciphertext|encrypted|secret|token/i;
const CONSTRAINT_CLAUSE = /^(primary|foreign|unique|check|constraint)\b/i;

/** Strip `-- …` line comments so a comment word (e.g. "instance secret") is never mistaken for a column name. */
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/**
 * Every (table, column) declared in `sql` — both `ALTER TABLE … ADD COLUMN` and CREATE TABLE column bodies —
 * whose column name matches the sensitive pattern. Constraint clauses (PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT)
 * are skipped, and none of their keywords match the pattern anyway, so the result is real columns only.
 */
function sensitiveColumnsInSql(sql: string): Array<{ table: string; column: string }> {
  const clean = stripSqlLineComments(sql);
  const found: Array<{ table: string; column: string }> = [];

  const addColumn = /alter\s+table\s+([a-z0-9_]+)\s+add\s+column\s+([a-z0-9_]+)/gi;
  for (let m = addColumn.exec(clean); m; m = addColumn.exec(clean)) {
    const [, table, column] = m;
    if (table && column) found.push({ table, column });
  }

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s*\(/gi;
  for (let m = createTable.exec(clean); m; m = createTable.exec(clean)) {
    const table = m[1];
    if (!table) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const bodyStart = i;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === "(") depth++;
      else if (clean[i] === ")") depth--;
    }
    for (const raw of clean.slice(bodyStart, i - 1).split("\n")) {
      const line = raw.trim();
      if (!line || CONSTRAINT_CLAUSE.test(line)) continue;
      const col = /^([a-z_][a-z0-9_]*)/i.exec(line);
      if (col?.[1]) found.push({ table, column: col[1] });
    }
  }

  return found.filter(({ column }) => SENSITIVE_COLUMN.test(column));
}

function sensitiveColumnsInMigrations(): Array<{ table: string; column: string }> {
  const dir = join(process.cwd(), "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .flatMap((name) => sensitiveColumnsInSql(readFileSync(join(dir, name), "utf8")));
}

function isClassified(table: string, column: string): boolean {
  return Boolean(REDACTED_COLUMNS[table]?.includes(column) || EXPORT_REVIEWED_NON_SECRET_COLUMNS[table]?.includes(column));
}

describe("export-d1-core redaction-list drift guard (#9651)", () => {
  it("classifies every sensitive-named column in migrations/ as redacted or reviewed-non-secret", () => {
    const unclassified = sensitiveColumnsInMigrations()
      .filter(({ table, column }) => !isClassified(table, column))
      .map(({ table, column }) => `${table}.${column}`)
      .sort();
    expect(unclassified).toEqual([]);
  });

  it("proves the four drifted families are actually present in migrations/ and now redacted", () => {
    const seen = new Set(sensitiveColumnsInMigrations().map(({ table, column }) => `${table}.${column}`));
    const drifted: Array<[string, string]> = [
      ["orb_enrollments", "secret_value_ciphertext"],
      ["orb_enrollments", "secret_value_iv"],
      ["orb_enrollments", "secret_value_salt"],
      ["provider_credentials", "ciphertext"],
      ["orb_instances", "ingest_secret_hash"],
    ];
    for (const [table, column] of drifted) {
      expect(seen.has(`${table}.${column}`)).toBe(true);
      expect(REDACTED_COLUMNS[table]).toContain(column);
    }
    // orb_webhook_events.payload_hash is NOT sensitive-named, so it never reaches the guard — but the
    // DO-NOT-MIGRATE list still redacts it (same purpose as webhook_events.payload_hash), which is the point.
    expect(REDACTED_COLUMNS.orb_webhook_events).toContain("payload_hash");
  });

  it("is not trivially green — the detection helper flags a synthetic secret column", () => {
    const fixture = "ALTER TABLE t ADD COLUMN some_secret_ciphertext TEXT;";
    expect(sensitiveColumnsInSql(fixture)).toEqual([{ table: "t", column: "some_secret_ciphertext" }]);
    expect(isClassified("t", "some_secret_ciphertext")).toBe(false);

    // It also catches a CREATE TABLE body column and ignores constraint clauses + comment words.
    const createFixture = ["CREATE TABLE demo (", "  id TEXT PRIMARY KEY,", "  api_token TEXT NOT NULL, -- an instance secret in a COMMENT, not a column", "  PRIMARY KEY (id)", ");"].join("\n");
    expect(sensitiveColumnsInSql(createFixture)).toEqual([{ table: "demo", column: "api_token" }]);
  });

  it("has no dead EXPORT_REVIEWED_NON_SECRET_COLUMNS entries — every reviewed column still exists in migrations/", () => {
    const live = new Set(sensitiveColumnsInMigrations().map(({ table, column }) => `${table}.${column}`));
    const dead: string[] = [];
    for (const [table, columns] of Object.entries(EXPORT_REVIEWED_NON_SECRET_COLUMNS)) {
      for (const column of columns) {
        if (!live.has(`${table}.${column}`)) dead.push(`${table}.${column}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("keeps EXPORT_REVIEWED_NON_SECRET_COLUMNS reviewed — no redacted column is also listed as non-secret", () => {
    const overlap: string[] = [];
    for (const [table, columns] of Object.entries(EXPORT_REVIEWED_NON_SECRET_COLUMNS)) {
      for (const column of columns) {
        if (REDACTED_COLUMNS[table]?.includes(column)) overlap.push(`${table}.${column}`);
      }
    }
    expect(overlap).toEqual([]);
  });
});
