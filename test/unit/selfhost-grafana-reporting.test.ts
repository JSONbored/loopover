import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];
const sqliteCliAvailable = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-reporting-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function runExporter(root: string, sourceDb: string, outDb: string): void {
  execFileSync("sh", ["scripts/export-grafana-reporting-db.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITTENSORY_REPORTING_SOURCE_DB: sourceDb,
      GITTENSORY_REPORTING_DIR: root,
      GITTENSORY_REPORTING_DB: outDb,
    },
    stdio: "pipe",
  });
}

(sqliteCliAvailable ? describe : describe.skip)("Grafana reporting exporter", () => {
  it("prefers current pull request rows while preserving non-overlapping legacy review history", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE review_targets (
        kind TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        submitter TEXT,
        status TEXT NOT NULL,
        verdict TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO review_targets (kind, repo, number, submitter, status, verdict, title, created_at, updated_at)
      VALUES
        ('pull_request', 'JSONbored/gittensory', 1690, 'stale', 'closed', 'close', 'stale current PR', '2026-06-22T17:00:00Z', '2026-06-22T17:00:00Z'),
        ('pull_request', 'JSONbored/gittensory', 1049, 'bohdansolovie', 'closed', 'close', 'historical PR', '2026-06-22T17:28:56Z', '2026-06-22T17:28:56Z');

      CREATE TABLE pull_requests (
        repo_full_name TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        author_login TEXT,
        merged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pull_requests (repo_full_name, number, title, state, author_login, merged_at, created_at, updated_at)
      VALUES
        ('JSONbored/gittensory', 1690, 'fresh advisory PR', 'open', 'JSONbored', NULL, '2026-06-28T21:00:00Z', '2026-06-28T21:39:58Z'),
        ('JSONbored/gittensory', 1691, 'fresh merged PR', 'closed', 'tmimmanuel', '2026-06-28T21:46:51Z', '2026-06-28T21:30:00Z', '2026-06-28T21:47:36Z');

      CREATE TABLE advisories (
        repo_full_name TEXT NOT NULL,
        pull_number INTEGER,
        conclusion TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO advisories (repo_full_name, pull_number, conclusion, updated_at)
      VALUES
        ('JSONbored/gittensory', 1690, 'failure', '2026-06-28T21:25:00Z'),
        ('JSONbored/gittensory', 1690, 'neutral', '2026-06-28T21:40:00Z'),
        ('JSONbored/gittensory', 1691, 'success', '2026-06-28T21:47:40Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("3");
    expect(sqlite(outDb, "SELECT submitter || '|' || status || '|' || verdict || '|' || updated_at FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1690;")).toBe(
      "JSONbored|commented|comment|2026-06-28T21:40:00Z",
    );
    expect(sqlite(outDb, "SELECT status || '|' || verdict || '|' || updated_at FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1691;")).toBe(
      "merged|merge|2026-06-28T21:47:40Z",
    );
    expect(sqlite(outDb, "SELECT title FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1049;")).toBe("historical PR");
  });

  it("falls back to legacy review_targets when the current PR cache is absent", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE review_targets (
        kind TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        submitter TEXT,
        status TEXT NOT NULL,
        verdict TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO review_targets (kind, repo, number, submitter, status, verdict, title, created_at, updated_at)
      VALUES ('pull_request', 'JSONbored/gittensory', 1049, 'bohdansolovie', 'closed', 'close', 'legacy PR', '2026-06-22T17:28:56Z', '2026-06-22T17:28:56Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT repo || '#' || number || '|' || status || '|' || verdict FROM review_targets;")).toBe(
      "JSONbored/gittensory#1049|closed|close",
    );
  });

  it("copies durable AI usage estimate rows into the redacted reporting database", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, status, estimated_neurons, detail, metadata_json, created_at)
      VALUES ('ai_review_pr', 'codex:gpt-5.5', 'ok', 42, 'done', '{"repoFullName":"JSONbored/gittensory","pullNumber":1678,"private":"drop"}', '2026-06-28T00:00:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT estimated_neurons FROM ai_usage_events;")).toBe("42");
    expect(sqlite(outDb, "SELECT json_extract(metadata_json, '$.repoFullName') FROM ai_usage_events;")).toBe("JSONbored/gittensory");
    expect(sqlite(outDb, "SELECT json_extract(metadata_json, '$.private') IS NULL FROM ai_usage_events;")).toBe("1");
    expect(sqlite(outDb, "SELECT sum(estimated_neurons) FROM ai_usage_events WHERE feature = 'ai_review_pr' AND (('+' || model || '+') LIKE '%+codex+%' OR ('+' || model || '+') LIKE '%+codex:%');")).toBe("42");
  });

  it("keeps the dashboard schema valid when an older source DB has no estimate column", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, status, detail, metadata_json, created_at)
      VALUES ('ai_review_pr', 'codex', 'error', 'failed', '{"repoFullName":"JSONbored/gittensory","pullNumber":1678}', '2026-06-28T00:00:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT estimated_neurons FROM ai_usage_events;")).toBe("0");
  });
});
