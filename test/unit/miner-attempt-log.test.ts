import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/gittensory-engine/src/miner/attempt-log.js");
});

import {
  appendAttemptLogEvent,
  closeDefaultAttemptLog,
  exportAttemptLogJsonl,
  initAttemptLog,
  readAttemptLogEvents,
  resolveAttemptLogDbPath,
} from "../../packages/gittensory-miner/lib/attempt-log.js";

const roots: string[] = [];
const logs: Array<{ close(): void }> = [];

function tempAttemptLog() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-log-"));
  roots.push(root);
  const log = initAttemptLog(join(root, "nested", "attempt-log.sqlite3"));
  logs.push(log);
  return log;
}

const baseEvent = {
  attemptId: "attempt-1",
  actionClass: "codegen",
  mode: "live",
  reason: "live run",
} as const;

afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  closeDefaultAttemptLog();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner attempt log (#4294)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveAttemptLogDbPath({ LOOPOVER_MINER_ATTEMPT_LOG_DB: "/custom/a.sqlite3" })).toBe(
      "/custom/a.sqlite3",
    );
    expect(resolveAttemptLogDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/attempt-log.sqlite3",
    );
    expect(resolveAttemptLogDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/loopover-miner/attempt-log.sqlite3",
    );
    expect(resolveAttemptLogDbPath({})).toMatch(/\/\.config\/loopover-miner\/attempt-log\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and reads empty before any append", () => {
    const log = tempAttemptLog();
    expect(statSync(log.dbPath).mode & 0o077).toBe(0);
    expect(log.readAttemptLogEvents()).toEqual([]);
  });

  it("appends an event and reads it back verbatim (JSON payload round-trip)", () => {
    const log = tempAttemptLog();
    const entry = log.appendAttemptLogEvent({
      eventType: "attempt_started",
      ...baseEvent,
      payload: { workingDirectory: "/tmp/work" },
    });
    expect(entry).toMatchObject({
      seq: 1,
      eventType: "attempt_started",
      attemptId: "attempt-1",
      actionClass: "codegen",
      mode: "live",
      reason: "live run",
      payload: { workingDirectory: "/tmp/work" },
    });
    expect(typeof entry.id).toBe("number");
    expect(typeof entry.createdAt).toBe("string");
    expect(log.readAttemptLogEvents()).toEqual([entry]);
  });

  it("accepts attempt_tool_edit events for tool/edit tracing", () => {
    const log = tempAttemptLog();
    const entry = log.appendAttemptLogEvent({
      eventType: "attempt_tool_edit",
      ...baseEvent,
      reason: "edited src/a.ts",
      payload: { path: "src/a.ts", operation: "edit" },
    });
    expect(entry.eventType).toBe("attempt_tool_edit");
    expect(entry.payload).toEqual({ path: "src/a.ts", operation: "edit" });
  });

  it("assigns a strictly monotonic, gapless, unique seq across many appends", () => {
    const log = tempAttemptLog();
    for (let i = 0; i < 50; i += 1) {
      log.appendAttemptLogEvent({
        eventType: "attempt_tool_edit",
        ...baseEvent,
        reason: `edit ${i}`,
        payload: { i },
      });
    }
    const seqs = log.readAttemptLogEvents().map((entry) => entry.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_unused, i) => i + 1));
    expect(new Set(seqs).size).toBe(50);
  });

  it("filters by attemptId and treats a null filter as unscoped", () => {
    const log = tempAttemptLog();
    log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent, attemptId: "a-1" });
    log.appendAttemptLogEvent({
      eventType: "attempt_succeeded",
      ...baseEvent,
      attemptId: "a-2",
      reason: "done",
    });
    log.appendAttemptLogEvent({
      eventType: "attempt_tool_edit",
      ...baseEvent,
      attemptId: "a-1",
      reason: "edit",
      payload: { path: "x.ts" },
    });
    expect(log.readAttemptLogEvents({ attemptId: "a-1" }).map((entry) => entry.eventType)).toEqual([
      "attempt_started",
      "attempt_tool_edit",
    ]);
    expect(log.readAttemptLogEvents({ attemptId: null }).map((entry) => entry.attemptId)).toEqual([
      "a-1",
      "a-2",
      "a-1",
    ]);
  });

  it("exports one attempt's trace as JSONL using the engine formatter", () => {
    const log = tempAttemptLog();
    log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent, attemptId: "trace-1" });
    log.appendAttemptLogEvent({
      eventType: "attempt_succeeded",
      ...baseEvent,
      attemptId: "trace-1",
      reason: "done",
    });
    log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent, attemptId: "trace-2" });
    const jsonl = log.exportAttemptLogJsonl("trace-1");
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).eventType).toBe("attempt_started");
    expect(JSON.parse(lines[1]!).eventType).toBe("attempt_succeeded");
    expect(log.exportAttemptLogJsonl("missing")).toBe("");
  });

  it("rejects malformed events before insert and preserves insertion order", () => {
    const log = tempAttemptLog();
    log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent });
    expect(() =>
      log.appendAttemptLogEvent({
        eventType: "bogus" as "attempt_started",
        ...baseEvent,
      }),
    ).toThrow(/invalid_event_type/);
    expect(log.readAttemptLogEvents()).toHaveLength(1);
  });

  it("rejects invalid attemptId filter types before querying SQLite", () => {
    const log = tempAttemptLog();
    expect(() => log.readAttemptLogEvents({ attemptId: 42 as unknown as string })).toThrow(
      /invalid_attempt_id/,
    );
    expect(() => log.exportAttemptLogJsonl("  ")).toThrow(/invalid_attempt_id/);
  });

  it("rejects a payload JSON would not round-trip verbatim, and accepts a nested JSON-safe one", () => {
    const log = tempAttemptLog();
    expect(() =>
      log.appendAttemptLogEvent({
        eventType: "attempt_tool_edit",
        ...baseEvent,
        reason: "bad",
        payload: { a: undefined },
      }),
    ).toThrow(/invalid_payload/);
    expect(() =>
      log.appendAttemptLogEvent({
        eventType: "attempt_tool_edit",
        ...baseEvent,
        reason: "bad",
        payload: { a: Number.NaN },
      }),
    ).toThrow(/invalid_payload/);
    const entry = log.appendAttemptLogEvent({
      eventType: "attempt_tool_edit",
      ...baseEvent,
      reason: "ok",
      payload: { a: { b: [1, "two", true, null] } },
    });
    expect(log.readAttemptLogEvents()).toContainEqual(entry);
  });

  it("rejects a corrupted payload blob on read instead of returning malformed data", () => {
    const log = tempAttemptLog();
    log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent });
    const raw = new DatabaseSync(log.dbPath);
    raw.prepare("UPDATE attempt_log_events SET payload_json = ? WHERE id = 1").run("{bad");
    raw.close();
    expect(() => log.readAttemptLogEvents()).toThrow("corrupted_attempt_log_row");
  });

  it("uses the default singleton helpers and closes cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-log-default-"));
    roots.push(root);
    const previousConfigDir = process.env.LOOPOVER_MINER_CONFIG_DIR;
    process.env.LOOPOVER_MINER_CONFIG_DIR = root;
    try {
      const entry = appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent });
      expect(readAttemptLogEvents()).toEqual([entry]);
      expect(exportAttemptLogJsonl("attempt-1")).toBeTruthy();
      closeDefaultAttemptLog();
      closeDefaultAttemptLog();
    } finally {
      if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
      else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
    }
  });

  it("is append-only: the module source issues no UPDATE or DELETE against the ledger", () => {
    const source = readFileSync("packages/gittensory-miner/lib/attempt-log.js", "utf8");
    expect(source).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });

  it("appends and reads back provider/costUsd/tokensUsed, null when omitted (#5185)", () => {
    const log = tempAttemptLog();
    const withValues = log.appendAttemptLogEvent({
      eventType: "attempt_outcome_summary",
      ...baseEvent,
      actionClass: "attempt_submitted",
      reason: "attempt finished",
      provider: "claude-cli",
      costUsd: 0.42,
      tokensUsed: 1000,
    });
    expect(withValues).toMatchObject({ provider: "claude-cli", costUsd: 0.42, tokensUsed: 1000 });

    const omitted = log.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent });
    expect(omitted).toMatchObject({ provider: null, costUsd: null, tokensUsed: null });

    expect(log.readAttemptLogEvents()).toEqual([withValues, omitted]);
  });

  it("migrates a pre-#5185 on-disk file missing provider/cost_usd/tokens_used columns", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-log-migrate-"));
    roots.push(root);
    const dbPath = join(root, "attempt-log.sqlite3");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE attempt_log_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action_class TEXT NOT NULL,
        mode TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    raw
      .prepare(
        "INSERT INTO attempt_log_events (seq, attempt_id, event_type, action_class, mode, reason, payload_json, created_at) VALUES (1, 'attempt-1', 'attempt_started', 'codegen', 'live', 'live run', '{}', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    raw.close();

    const log = initAttemptLog(dbPath);
    logs.push(log);
    const preExisting = log.readAttemptLogEvents();
    expect(preExisting).toHaveLength(1);
    expect(preExisting[0]).toMatchObject({ provider: null, costUsd: null, tokensUsed: null });

    const appended = log.appendAttemptLogEvent({
      eventType: "attempt_outcome_summary",
      ...baseEvent,
      actionClass: "attempt_submitted",
      reason: "attempt finished",
      provider: "agent-sdk",
      costUsd: 1.5,
    });
    expect(appended).toMatchObject({ provider: "agent-sdk", costUsd: 1.5, tokensUsed: null });
  });

  it("re-opening an already-migrated file is a no-op: no duplicate/failing ALTER TABLE", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-log-reopen-"));
    roots.push(root);
    const dbPath = join(root, "attempt-log.sqlite3");

    const first = initAttemptLog(dbPath);
    first.appendAttemptLogEvent({ eventType: "attempt_started", ...baseEvent });
    first.close();

    // ensureOutcomeColumns runs again on this second open; provider/cost_usd/tokens_used are already present from
    // the first open's own migration, so every per-column ALTER TABLE this time must be skipped, not re-run.
    const second = initAttemptLog(dbPath);
    logs.push(second);
    expect(second.readAttemptLogEvents()).toHaveLength(1);
    const appended = second.appendAttemptLogEvent({
      eventType: "attempt_outcome_summary",
      ...baseEvent,
      actionClass: "attempt_submitted",
      reason: "attempt finished",
      provider: "claude-cli",
    });
    expect(appended).toMatchObject({ provider: "claude-cli", costUsd: null, tokensUsed: null });
  });
});
