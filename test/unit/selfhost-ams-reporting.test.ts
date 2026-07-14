import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Export coverage for scripts/export-ams-reporting-db.sh (#5184 follow-up / PR #5471's flagged confidentiality
// gap): Grafana must never mount the miner's live LOOPOVER_MINER_CONFIG_DIR ledgers directly, so this script
// reads them read-only and writes a redacted snapshot for ams-ledgers-datasource.test.ts's provisioning to point
// at. Mirrors selfhost-grafana-reporting.test.ts's spawn-the-real-script style.
const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-ams-reporting-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function runExporter(
  root: string,
  overrides: Partial<{
    attemptLogSource: string;
    predictionLedgerSource: string;
    reportingDir: string;
    scriptVersion: string;
    intervalHint: string;
  }> = {},
): string {
  const reportingDir = overrides.reportingDir ?? join(root, "reporting");
  return execFileSync("sh", ["scripts/export-ams-reporting-db.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOOPOVER_AMS_ATTEMPT_LOG_SOURCE_DB: overrides.attemptLogSource ?? join(root, "attempt-log.sqlite3"),
      LOOPOVER_AMS_PREDICTION_LEDGER_SOURCE_DB: overrides.predictionLedgerSource ?? join(root, "prediction-ledger.sqlite3"),
      LOOPOVER_REPORTING_DIR: reportingDir,
      ...(overrides.scriptVersion ? { LOOPOVER_AMS_REPORTING_SCRIPT_VERSION: overrides.scriptVersion } : {}),
    },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function sqlLiteral(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function seedAttemptLog(
  db: string,
  rows: Array<{
    seq: number;
    attemptId: string;
    eventType: string;
    actionClass: string;
    mode: string;
    reason: string;
    payloadJson: string;
    provider?: string | null;
    costUsd?: number | null;
    tokensUsed?: number | null;
    createdAt: string;
  }>,
): void {
  sqlite(
    db,
    `
    CREATE TABLE attempt_log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_class TEXT NOT NULL,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      provider TEXT,
      cost_usd REAL,
      tokens_used INTEGER,
      created_at TEXT NOT NULL
    );
    ${rows
      .map(
        (r) =>
          `INSERT INTO attempt_log_events (seq, attempt_id, event_type, action_class, mode, reason, payload_json, provider, cost_usd, tokens_used, created_at) VALUES (${r.seq}, '${r.attemptId}', '${r.eventType}', '${r.actionClass}', '${r.mode}', '${r.reason.replace(/'/g, "''")}', '${r.payloadJson.replace(/'/g, "''")}', ${sqlLiteral(r.provider ?? null)}, ${sqlLiteral(r.costUsd ?? null)}, ${sqlLiteral(r.tokensUsed ?? null)}, '${r.createdAt}');`,
      )
      .join("\n")}
  `,
  );
}

function seedPredictionLedger(db: string, rows: Array<{ ts: string; repo: string; targetId: number; headSha: string; conclusion: string; pack: string; readinessScore: number; blockerCodesJson: string; warningCodesJson: string; engineVersion: string }>): void {
  sqlite(
    db,
    `
    CREATE TABLE predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      head_sha TEXT,
      conclusion TEXT NOT NULL,
      pack TEXT NOT NULL,
      readiness_score REAL,
      blocker_codes_json TEXT NOT NULL,
      warning_codes_json TEXT NOT NULL,
      engine_version TEXT NOT NULL
    );
    ${rows
      .map(
        (r) =>
          `INSERT INTO predictions (ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version) VALUES ('${r.ts}', '${r.repo}', ${r.targetId}, '${r.headSha}', '${r.conclusion}', '${r.pack}', ${r.readinessScore}, '${r.blockerCodesJson.replace(/'/g, "''")}', '${r.warningCodesJson.replace(/'/g, "''")}', '${r.engineVersion}');`,
      )
      .join("\n")}
  `,
  );
}

describe("scripts/export-ams-reporting-db.sh", () => {
  it("exports attempt_log_events but drops the free-form reason and payload_json columns", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [
      {
        seq: 1,
        attemptId: "attempt-1",
        eventType: "started",
        actionClass: "write",
        mode: "live",
        reason: "internal reasoning that must never leave the miner's own box",
        payloadJson: '{"diff":"private file contents"}',
        createdAt: "2026-07-12T00:00:00Z",
      },
    ]);

    runExporter(root, { attemptLogSource: src });

    const outDb = join(root, "reporting", "ams-attempt-log.sqlite");
    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM attempt_log_events;")).toBe("1");
    expect(
      sqlite(
        outDb,
        "SELECT seq || '|' || attempt_id || '|' || event_type || '|' || action_class || '|' || mode || '|' || created_at FROM attempt_log_events;",
      ),
    ).toBe("1|attempt-1|started|write|live|2026-07-12T00:00:00Z");
    expect(sqlite(outDb, "SELECT count(*) FROM pragma_table_info('attempt_log_events') WHERE name IN ('reason', 'payload_json');")).toBe("0");
  });

  it("exports attempt_log_events' provider/cost_usd/tokens_used (#5185) unchanged, NULL when unset", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [
      {
        seq: 1,
        attemptId: "attempt-1",
        eventType: "attempt_outcome_summary",
        actionClass: "attempt_submitted",
        mode: "live",
        reason: "attempt finished",
        payloadJson: "{}",
        provider: "claude-cli",
        costUsd: 0.42,
        tokensUsed: 1000,
        createdAt: "2026-07-12T00:00:00Z",
      },
      {
        seq: 2,
        attemptId: "attempt-1",
        eventType: "attempt_started",
        actionClass: "codegen",
        mode: "live",
        reason: "live run",
        payloadJson: "{}",
        createdAt: "2026-07-12T00:00:01Z",
      },
    ]);

    runExporter(root, { attemptLogSource: src });

    const outDb = join(root, "reporting", "ams-attempt-log.sqlite");
    expect(
      sqlite(outDb, "SELECT provider || '|' || cost_usd || '|' || tokens_used FROM attempt_log_events WHERE seq = 1;"),
    ).toBe("claude-cli|0.42|1000");
    expect(
      sqlite(
        outDb,
        "SELECT COALESCE(provider, 'NULL') || '|' || COALESCE(cost_usd, 'NULL') || '|' || COALESCE(tokens_used, 'NULL') FROM attempt_log_events WHERE seq = 2;",
      ),
    ).toBe("NULL|NULL|NULL");
  });

  it("exports predictions with every column intact (already bounded/structured, no free text)", () => {
    const root = tmpRoot();
    const src = join(root, "prediction-ledger.sqlite3");
    seedPredictionLedger(src, [
      {
        ts: "2026-07-12T00:00:00Z",
        repo: "acme/widgets",
        targetId: 42,
        headSha: "abc123",
        conclusion: "merge",
        pack: "default",
        readinessScore: 0.92,
        blockerCodesJson: "[]",
        warningCodesJson: '["stale_branch"]',
        engineVersion: "1.0.0",
      },
    ]);

    runExporter(root, { predictionLedgerSource: src });

    const outDb = join(root, "reporting", "ams-prediction-ledger.sqlite");
    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(
      sqlite(
        outDb,
        "SELECT repo_full_name || '|' || target_id || '|' || conclusion || '|' || readiness_score || '|' || warning_codes_json FROM predictions;",
      ),
    ).toBe("acme/widgets|42|merge|0.92|[\"stale_branch\"]");
  });

  it("fails open with an empty, valid reporting DB when a source ledger is missing, without blocking the other ledger", () => {
    const root = tmpRoot();
    const predictionSrc = join(root, "prediction-ledger.sqlite3");
    seedPredictionLedger(predictionSrc, [
      { ts: "2026-07-12T00:00:00Z", repo: "acme/widgets", targetId: 1, headSha: "s", conclusion: "merge", pack: "default", readinessScore: 1, blockerCodesJson: "[]", warningCodesJson: "[]", engineVersion: "1.0.0" },
    ]);

    runExporter(root, {
      attemptLogSource: join(root, "does-not-exist-attempt-log.sqlite3"),
      predictionLedgerSource: predictionSrc,
    });

    const attemptOut = join(root, "reporting", "ams-attempt-log.sqlite");
    const predictionOut = join(root, "reporting", "ams-prediction-ledger.sqlite");
    expect(sqlite(attemptOut, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(attemptOut, "SELECT count(*) FROM attempt_log_events;")).toBe("0");
    expect(sqlite(predictionOut, "SELECT count(*) FROM predictions;")).toBe("1");
  });

  it("skips the rebuild on a second run when the source is unchanged (#3895-style incremental fast path)", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [{ seq: 1, attemptId: "a1", eventType: "started", actionClass: "write", mode: "live", reason: "r", payloadJson: "{}", createdAt: "2026-07-12T00:00:00Z" }]);

    const first = runExporter(root, { attemptLogSource: src });
    expect(first).toContain("export complete");
    const second = runExporter(root, { attemptLogSource: src });
    expect(second).toContain("export skipped: source unchanged");
  });

  it("redoes the rebuild once the source actually changes, reflecting the new row", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [{ seq: 1, attemptId: "a1", eventType: "started", actionClass: "write", mode: "live", reason: "r", payloadJson: "{}", createdAt: "2026-07-12T00:00:00Z" }]);
    runExporter(root, { attemptLogSource: src });

    sqlite(src, "INSERT INTO attempt_log_events (seq, attempt_id, event_type, action_class, mode, reason, payload_json, created_at) VALUES (2, 'a1', 'succeeded', 'write', 'live', 'r2', '{}', '2026-07-12T00:01:00Z');");
    const second = runExporter(root, { attemptLogSource: src });

    expect(second).toContain("export complete");
    const outDb = join(root, "reporting", "ams-attempt-log.sqlite");
    expect(sqlite(outDb, "SELECT count(*) FROM attempt_log_events;")).toBe("2");
  });

  it("forces a fresh rebuild when the script's own logic version changes, even with source data unchanged", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [{ seq: 1, attemptId: "a1", eventType: "started", actionClass: "write", mode: "live", reason: "r", payloadJson: "{}", createdAt: "2026-07-12T00:00:00Z" }]);
    runExporter(root, { attemptLogSource: src, scriptVersion: "1" });

    const second = runExporter(root, { attemptLogSource: src, scriptVersion: "2" });

    expect(second).toContain("export complete");
  });

  it("preserves the last-good reporting DB when the source table goes missing after a prior successful export", () => {
    const root = tmpRoot();
    const src = join(root, "attempt-log.sqlite3");
    seedAttemptLog(src, [{ seq: 1, attemptId: "a1", eventType: "started", actionClass: "write", mode: "live", reason: "r", payloadJson: "{}", createdAt: "2026-07-12T00:00:00Z" }]);
    runExporter(root, { attemptLogSource: src });

    sqlite(src, "DROP TABLE attempt_log_events;");
    // The "table absent" log line goes to stderr (matching export-grafana-reporting-db.sh's own convention of
    // routing degraded/anomaly paths to stderr, not stdout) -- not captured by runExporter's stdout-only pipe,
    // so this test asserts on the BEHAVIOR (last-good output preserved) rather than the log text.
    runExporter(root, { attemptLogSource: src });

    const outDb = join(root, "reporting", "ams-attempt-log.sqlite");
    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM attempt_log_events;")).toBe("1");
  });

  it("still detects a new row via the cheap count+max fast path even when the row count itself stays the same size class", () => {
    const root = tmpRoot();
    const src = join(root, "prediction-ledger.sqlite3");
    seedPredictionLedger(src, [
      { ts: "2026-07-12T00:00:00Z", repo: "acme/widgets", targetId: 1, headSha: "s1", conclusion: "merge", pack: "default", readinessScore: 1, blockerCodesJson: "[]", warningCodesJson: "[]", engineVersion: "1.0.0" },
    ]);
    runExporter(root, { predictionLedgerSource: src });

    sqlite(src, "DELETE FROM predictions;");
    sqlite(
      src,
      "INSERT INTO predictions (ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version) VALUES ('2026-07-12T00:05:00Z', 'acme/widgets', 2, 's2', 'close', 'default', 0.1, '[\"linked_issue_missing\"]', '[]', '1.0.0');",
    );
    const second = runExporter(root, { predictionLedgerSource: src });

    expect(second).toContain("export complete");
    const outDb = join(root, "reporting", "ams-prediction-ledger.sqlite");
    expect(sqlite(outDb, "SELECT target_id || '|' || conclusion FROM predictions;")).toBe("2|close");
  });

  it("upgrades a stale pre-#5637 output's schema (missing provider/cost_usd/tokens_used) while preserving last-good when the source stays missing throughout (migration-drift regression)", () => {
    // Reproduces a real drift window in this script's own history: PR #5471 first shipped this script
    // with attempt_log_events' DDL missing provider/cost_usd/tokens_used; PR #5637 added those columns
    // to the DDL one day later. An instance whose ledger source has NEVER existed (no miner co-located
    // with this reporting exporter) creates its one-and-only output under whichever DDL was current at
    // that moment, then the "source missing, output already exists -> preserve last-good" fail-open
    // path (export_ledger's very first branch) returns before ever reaching the fingerprint/
    // SCRIPT_VERSION rebuild check -- so a later DDL widening was previously invisible to this instance
    // forever, and every panel in miner-usage.json that selects provider/cost_usd/tokens_used hard-fails
    // with "no such column" rather than just showing empty.
    const root = tmpRoot();
    const reportingDir = join(root, "reporting");
    const attemptOut = join(reportingDir, "ams-attempt-log.sqlite");
    mkdirSync(reportingDir, { recursive: true });
    // Seed the OUTPUT directly with the pre-#5637 schema and one real row -- simulating a stale export
    // this script itself produced before it ever knew about provider/cost_usd/tokens_used.
    sqlite(
      attemptOut,
      `
      CREATE TABLE attempt_log_events (
        id INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action_class TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO attempt_log_events (id, seq, attempt_id, event_type, action_class, mode, created_at)
        VALUES (1, 1, 'a1', 'started', 'write', 'live', '2026-07-11T00:00:00Z');
    `,
    );

    // Source never existed -- exactly the "engine-only, no co-located miner" deployment shape.
    runExporter(root, { attemptLogSource: join(root, "does-not-exist-attempt-log.sqlite3"), reportingDir });

    expect(sqlite(attemptOut, "PRAGMA quick_check;")).toBe("ok");
    const columns = sqlite(attemptOut, "SELECT group_concat(name) FROM pragma_table_info('attempt_log_events');").split(",");
    expect(columns).toEqual(expect.arrayContaining(["provider", "cost_usd", "tokens_used"]));
    // The pre-existing row survives untouched, with the newly-added columns correctly NULL (we never
    // had that data for it) rather than the row being dropped or fabricated.
    expect(sqlite(attemptOut, "SELECT count(*) FROM attempt_log_events;")).toBe("1");
    expect(sqlite(attemptOut, "SELECT attempt_id || '|' || coalesce(provider, 'NULL') FROM attempt_log_events;")).toBe("a1|NULL");
  });
});
