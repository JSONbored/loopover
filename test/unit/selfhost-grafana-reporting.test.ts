import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runExporter(root: string, sourceDb: string, outDb: string, env: Record<string, string> = {}): string {
  return execFileSync("sh", ["scripts/export-grafana-reporting-db.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITTENSORY_REPORTING_SOURCE_DB: sourceDb,
      GITTENSORY_REPORTING_DIR: root,
      GITTENSORY_REPORTING_DB: outDb,
      ...env,
    },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function fakePsql(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const psql = join(bin, "psql");
  writeFileSync(
    psql,
    `#!/bin/sh
args="$*"
case " $args " in
  *" postgres://"*|*" postgresql://"*)
    echo 'psql command line leaked postgres URL' >&2
    exit 8
    ;;
esac
case " \${PGHOST:-} \${PGPORT:-} \${PGUSER:-} \${PGPASSWORD:-} \${PGDATABASE:-} " in
  *" postgres://"*|*" postgresql://"*)
    echo 'psql received the whole postgres URL through an env var instead of split components' >&2
    exit 8
    ;;
esac
if [ "\${PGHOST:-}" != "postgres" ] || [ "\${PGPORT:-}" != "5432" ] || [ "\${PGUSER:-}" != "gittensory" ] || [ "\${PGPASSWORD:-}" != "pw" ] || [ "\${PGDATABASE:-}" != "gittensory" ]; then
  echo 'psql did not receive the split connection env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)' >&2
  exit 8
fi
case "$args" in
  *\\\\copy*)
    echo 'unexpected psql meta-command copy' >&2
    exit 9
    ;;
  *"information_schema.tables"*"pull_requests"*|*"information_schema.tables"*"advisories"*|*"information_schema.tables"*"review_targets"*|*"information_schema.tables"*"ai_usage_events"*|*"information_schema.tables"*"review_audit"*)
    printf '1\\n'
    ;;
  *"information_schema.columns"*"ai_usage_events"*"estimated_neurons"*|\
  *"information_schema.columns"*"ai_usage_events"*"provider"*|\
  *"information_schema.columns"*"ai_usage_events"*"effort"*|\
  *"information_schema.columns"*"ai_usage_events"*"input_tokens"*|\
  *"information_schema.columns"*"ai_usage_events"*"output_tokens"*|\
  *"information_schema.columns"*"ai_usage_events"*"total_tokens"*|\
  *"information_schema.columns"*"ai_usage_events"*"cost_usd"*)
    printf '1\\n'
    ;;
  *"FROM current_pull_requests"*)
    printf '"JSONbored/gittensory",1690,JSONbored,commented,comment,"fresh advisory PR",2026-06-28T21:00:00Z,2026-06-28T21:40:00Z\\n'
    printf '"JSONbored/gittensory",1691,tmimmanuel,merged,merge,"fresh merged PR",2026-06-28T21:30:00Z,2026-06-28T21:47:40Z\\n'
    ;;
  *"FROM review_targets t"*)
    printf '"JSONbored/gittensory",1049,bohdansolovie,closed,close,"historical PR",2026-06-22T17:28:56Z,2026-06-22T17:28:56Z\\n'
    ;;
  *"FROM ai_usage_events"*)
    printf 'ai_review_pr,codex:gpt-5.5,codex,medium,ok,42,120,15,135,0.25,done,"{""repoFullName"" : ""JSONbored/gittensory"", ""pullNumber"" : 1678}",2026-06-28T00:00:00Z\\n'
    printf 'issue_plan,codex:gpt-5.5,codex,medium,ok,8,50,10,60,0.05,done,"{""repoFullName"" : ""JSONbored/gittensory"", ""pullNumber"" : null}",2026-06-28T00:01:00Z\\n'
    ;;
esac
`,
  );
  chmodSync(psql, 0o755);
  return bin;
}

function busyboxLikeMktemp(root: string): string {
  const bin = join(root, "busybox-bin");
  mkdirSync(bin);
  const mktemp = join(bin, "mktemp");
  writeFileSync(
    mktemp,
    `#!/bin/sh
if [ "$1" = "-d" ]; then
  base="\${TMPDIR:-/tmp}/tmp.$$"
  n=0
  while [ -e "$base-$n" ]; do n=$((n + 1)); done
  mkdir "$base-$n"
  printf '%s\\n' "$base-$n"
  exit 0
fi

case "$1" in
  *XXXXXX)
    base="\${1%XXXXXX}"
    n=0
    out="$base$n"
    while [ -e "$out" ]; do n=$((n + 1)); out="$base$n"; done
    : > "$out"
    printf '%s\\n' "$out"
    ;;
  *)
    echo 'mktemp: Invalid argument' >&2
    exit 1
    ;;
esac
`,
  );
  chmodSync(mktemp, 0o755);
  return bin;
}

// Captures the connection env vars psql actually receives (rather than asserting a fixed expected value inline
// like fakePsql) so callers can point it at ANY DATABASE_URL shape and inspect exactly what was parsed out.
function capturingPsql(root: string): { bin: string; captureFile: string } {
  const bin = join(root, "capture-bin");
  mkdirSync(bin);
  const psql = join(bin, "psql");
  const captureFile = join(root, "captured-env.txt");
  writeFileSync(
    psql,
    `#!/bin/sh
printf 'PGHOST=%s\\nPGPORT=%s\\nPGUSER=%s\\nPGPASSWORD=%s\\nPGDATABASE=%s\\n' "\${PGHOST:-}" "\${PGPORT:-}" "\${PGUSER:-}" "\${PGPASSWORD:-}" "\${PGDATABASE:-}" > "${captureFile}"
case "$*" in
  *"information_schema.tables"*) printf '1\\n' ;;
esac
`,
  );
  chmodSync(psql, 0o755);
  return { bin, captureFile };
}

function failingPsql(root: string): string {
  const bin = join(root, "broken-bin");
  mkdirSync(bin);
  const psql = join(bin, "psql");
  writeFileSync(
    psql,
    `#!/bin/sh
echo 'connection refused' >&2
exit 7
`,
  );
  chmodSync(psql, 0o755);
  return bin;
}

function failingCopyPsql(root: string): string {
  const bin = join(root, "copy-fail-bin");
  mkdirSync(bin);
  const psql = join(bin, "psql");
  writeFileSync(
    psql,
    `#!/bin/sh
args="$*"
case "$args" in
  *"information_schema.tables"*"pull_requests"*|*"information_schema.tables"*"advisories"*|*"information_schema.tables"*"review_targets"*|*"information_schema.tables"*"ai_usage_events"*|*"information_schema.tables"*"review_audit"*)
    printf '1\\n'
    ;;
  *"information_schema.columns"*"ai_usage_events"*"estimated_neurons"*)
    printf '1\\n'
    ;;
  *"FROM current_pull_requests"*)
    echo 'copy failed' >&2
    exit 7
    ;;
esac
`,
  );
  chmodSync(psql, 0o755);
  return bin;
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

      CREATE TABLE review_audit (
        id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        decision TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES
        ('g1', 'JSONbored/gittensory#1690', 'gate_decision', 'close', 'gittensory-native', '2026-06-28T21:25:00Z'),
        ('g2', 'JSONbored/gittensory#1690', 'gate_decision', 'hold', 'gittensory-native', '2026-06-28T21:40:00Z'),
        ('g3', 'JSONbored/gittensory#1691', 'gate_decision', 'merge', 'gittensory-native', '2026-06-28T21:47:40Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("3");
    // #1690's latest gate_decision is 'hold' (superseding the earlier 'close') -- the ROW_NUMBER "latest wins"
    // ordering is exercised here, not just a single-row join.
    expect(sqlite(outDb, "SELECT submitter || '|' || status || '|' || verdict || '|' || updated_at FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1690;")).toBe(
      "JSONbored|manual|manual|2026-06-28T21:40:00Z",
    );
    expect(sqlite(outDb, "SELECT status || '|' || verdict || '|' || updated_at FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1691;")).toBe(
      "merged|merge|2026-06-28T21:47:40Z",
    );
    expect(sqlite(outDb, "SELECT title FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1049;")).toBe("historical PR");
  });

  it("REGRESSION (#3511 dashboard bug): a merged/closed PR reports its OWN verdict, not 'manual', regardless of what review_audit's live gate_decision says", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
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
        ('JSONbored/gittensory', 2001, 'merged despite a stale held gate_decision', 'closed', 'JSONbored', '2026-07-05T09:43:12Z', '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z'),
        ('JSONbored/gittensory', 2002, 'closed (not merged) despite a stale held gate_decision', 'closed', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z'),
        ('JSONbored/gittensory', 2003, 'still open, genuinely held for manual review', 'open', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z'),
        ('JSONbored/gittensory', 2004, 'still open, no gate_decision recorded yet', 'open', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        decision TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES
        -- Reproduces the reported production shape: the gate held these PRs (a live, real 'hold' decision) at
        -- some point in the past -- a merged/closed PR must not be forced into verdict='manual' forever just
        -- because ITS OWN last-recorded live decision, before the terminal outcome, happened to be a hold.
        ('g1', 'JSONbored/gittensory#2001', 'gate_decision', 'hold', 'gittensory-native', '2026-07-05T09:31:00Z'),
        ('g2', 'JSONbored/gittensory#2002', 'gate_decision', 'hold', 'gittensory-native', '2026-07-05T09:31:00Z'),
        ('g3', 'JSONbored/gittensory#2003', 'gate_decision', 'hold', 'gittensory-native', '2026-07-05T09:31:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=2001;")).toBe("merged|merge");
    expect(sqlite(outDb, "SELECT status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=2002;")).toBe("closed|close");
    // A genuinely still-open PR reflects its live gate_decision verbatim (#3511 follow-up: this is the real fix
    // -- a still-open PR now reports the gate's ACTUAL current decision instead of an eternal placeholder).
    expect(sqlite(outDb, "SELECT status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=2003;")).toBe("manual|manual");
    // No gate_decision row at all (e.g. a brand-new PR the gate hasn't evaluated yet) fails safe: status='manual'
    // (something needs a look), verdict=NULL (no real signal to report, never fabricated).
    expect(sqlite(outDb, "SELECT status || '|' || (verdict IS NULL) FROM review_targets WHERE repo='JSONbored/gittensory' AND number=2004;")).toBe("manual|1");
  });

  it("a still-open PR whose live gate_decision is 'merge' or 'close' reports that verdict directly, with a distinct status from a genuine 'hold'", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
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
        ('JSONbored/gittensory', 3001, 'gate says merge, GitHub has not caught up yet', 'open', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z'),
        ('JSONbored/gittensory', 3002, 'gate says close, GitHub has not caught up yet', 'open', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        decision TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES
        ('g1', 'JSONbored/gittensory#3001', 'gate_decision', 'merge', 'gittensory-native', '2026-07-05T09:31:00Z'),
        ('g2', 'JSONbored/gittensory#3002', 'gate_decision', 'close', 'gittensory-native', '2026-07-05T09:31:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=3001;")).toBe("commented|merge");
    expect(sqlite(outDb, "SELECT status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=3002;")).toBe("manual|close");
  });

  it("ignores a gate_decision row from another source (e.g. 'reviewbot', the parity harness's authoritative side) so a shadow-comparison row never masquerades as the live verdict", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
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
      VALUES ('JSONbored/gittensory', 4001, 'only a reviewbot shadow row exists', 'open', 'JSONbored', NULL, '2026-07-05T09:30:00Z', '2026-07-05T09:43:12Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        decision TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES ('g1', 'JSONbored/gittensory#4001', 'gate_decision', 'merge', 'reviewbot', '2026-07-05T09:31:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT status || '|' || (verdict IS NULL) FROM review_targets WHERE repo='JSONbored/gittensory' AND number=4001;")).toBe("manual|1");
  });

  it("a source DB with ONLY review_audit (no pull_requests/review_targets/ai_usage_events) is recognized as having real data -- the exporter runs a fresh pass instead of preserving a stale last-good snapshot", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");

    // Seed a legitimate "last good" output from a normal run, so a wrongly-triggered skip would be observable
    // (the old snapshot would survive untouched instead of being replaced by a fresh, empty pass).
    sqlite(appDb, `
      CREATE TABLE pull_requests (
        repo_full_name TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
        author_login TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pull_requests (repo_full_name, number, title, state, author_login, merged_at, created_at, updated_at)
      VALUES ('JSONbored/gittensory', 9001, 'stale last-good PR', 'open', 'JSONbored', NULL, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL, target_id TEXT NOT NULL, event_type TEXT NOT NULL, decision TEXT,
        source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES ('g0', 'JSONbored/gittensory#9001', 'gate_decision', 'hold', 'gittensory-native', '2026-07-01T00:00:00Z');
    `);
    runExporter(root, appDb, outDb);
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("1");

    // Now point at a fresh source DB containing ONLY review_audit -- no pull_requests, review_targets, or
    // ai_usage_events at all.
    const onlyAuditDb = join(root, "only-audit.sqlite");
    sqlite(onlyAuditDb, `
      CREATE TABLE review_audit (
        id TEXT NOT NULL, target_id TEXT NOT NULL, event_type TEXT NOT NULL, decision TEXT,
        source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO review_audit (id, target_id, event_type, decision, source, created_at)
      VALUES ('g1', 'JSONbored/gittensory#9002', 'gate_decision', 'hold', 'gittensory-native', '2026-07-05T00:00:00Z');
    `);
    // Must not throw: a wrongly-triggered "no reporting source tables" skip exits non-zero when a last-good
    // snapshot already exists (see the seeded run above).
    expect(() => runExporter(root, onlyAuditDb, outDb)).not.toThrow();

    // The stale PR from the seeded run is GONE -- proving this was a genuine fresh pass (pull_requests doesn't
    // exist in the only-review_audit source, so nothing populates review_targets), not a preserved snapshot.
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("0");
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
        provider TEXT,
        effort TEXT,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, provider, effort, status, estimated_neurons, input_tokens, output_tokens, total_tokens, cost_usd, detail, metadata_json, created_at)
      VALUES
        ('ai_review_pr', 'codex:gpt-5.5', 'codex', 'medium', 'ok', 42, 120, 15, 135, 0.25, 'done', '{"repoFullName":"JSONbored/gittensory","pullNumber":1678,"private":"drop"}', '2026-06-28T00:00:00Z'),
        ('ai_slop_pr', 'claude-code', 'claude-code', 'default', 'ok', 7, 200, 25, 225, 0.5, 'done', '{"repoFullName":"JSONbored/sidequest","pullNumber":42,"private":"drop"}', '2026-06-28T00:01:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT feature || '|' || estimated_neurons FROM ai_usage_events ORDER BY created_at;")).toBe("ai_review_pr|42\nai_slop_pr|7");
    expect(sqlite(outDb, "SELECT provider || '|' || effort || '|' || input_tokens || '|' || output_tokens || '|' || total_tokens || '|' || cost_usd FROM ai_usage_events ORDER BY created_at;")).toBe("codex|medium|120|15|135|0.25\nclaude-code|default|200|25|225|0.5");
    expect(sqlite(outDb, "SELECT json_extract(metadata_json, '$.repoFullName') FROM ai_usage_events ORDER BY created_at;")).toBe("JSONbored/gittensory\nJSONbored/sidequest");
    expect(sqlite(outDb, "SELECT group_concat(json_extract(metadata_json, '$.private') IS NULL, '|') FROM ai_usage_events;")).toBe("1|1");
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
    expect(sqlite(outDb, "SELECT provider IS NULL, effort IS NULL, input_tokens, output_tokens, total_tokens, cost_usd FROM ai_usage_events;")).toBe("1|1|0|0|0|0.0");
  });

  it("exports the same redacted dashboard snapshot from Postgres", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const bin = fakePsql(root);
    const csvTmp = join(root, "csv temp");
    mkdirSync(csvTmp);

    runExporter(root, join(root, "unused.sqlite"), outDb, {
      DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: csvTmp,
    });

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("3");
    expect(sqlite(outDb, "SELECT submitter || '|' || status || '|' || verdict FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1690;")).toBe(
      "JSONbored|commented|comment",
    );
    expect(sqlite(outDb, "SELECT title FROM review_targets WHERE repo='JSONbored/gittensory' AND number=1049;")).toBe("historical PR");
    expect(sqlite(outDb, "SELECT feature || '|' || estimated_neurons FROM ai_usage_events ORDER BY created_at;")).toBe("ai_review_pr|42\nissue_plan|8");
    expect(sqlite(outDb, "SELECT provider || '|' || effort || '|' || input_tokens || '|' || output_tokens || '|' || total_tokens || '|' || cost_usd FROM ai_usage_events ORDER BY created_at;")).toBe("codex|medium|120|15|135|0.25\ncodex|medium|50|10|60|0.05");
    expect(sqlite(outDb, "SELECT DISTINCT json_extract(metadata_json, '$.repoFullName') FROM ai_usage_events;")).toBe("JSONbored/gittensory");
    expect(sqlite(outDb, "SELECT group_concat(json_extract(metadata_json, '$.private') IS NULL, '|') FROM ai_usage_events;")).toBe("1|1");
    expect(readdirSync(csvTmp)).toEqual([]);
  });

  it("uses BusyBox-compatible mktemp templates for Postgres CSV exports", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const psqlBin = fakePsql(root);
    const mktempBin = busyboxLikeMktemp(root);

    runExporter(root, join(root, "unused.sqlite"), outDb, {
      DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory",
      PATH: `${mktempBin}:${psqlBin}:${process.env.PATH ?? ""}`,
    });

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("3");
    expect(sqlite(outDb, "SELECT sum(estimated_neurons) FROM ai_usage_events;")).toBe("50");
  });

  it("REGRESSION (gate-flagged): a bracketed IPv6 Postgres host (postgres://u:p@[::1]:5432/db) is split correctly, not cut apart at the address's own internal colons", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const { bin, captureFile } = capturingPsql(root);

    runExporter(root, join(root, "unused.sqlite"), outDb, {
      DATABASE_URL: "postgres://gittensory:pw@[::1]:5432/gittensory",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    const captured = readFileSync(captureFile, "utf8");
    expect(captured).toContain("PGHOST=::1\n");
    expect(captured).toContain("PGPORT=5432\n");
    expect(captured).toContain("PGUSER=gittensory\n");
    expect(captured).toContain("PGPASSWORD=pw\n");
    expect(captured).toContain("PGDATABASE=gittensory\n");
  });

  it("REGRESSION: a bracketed IPv6 Postgres host with no port and no userinfo (postgres://[::1]/db) is split correctly", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const { bin, captureFile } = capturingPsql(root);

    runExporter(root, join(root, "unused.sqlite"), outDb, {
      DATABASE_URL: "postgres://[::1]/gittensory",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    const captured = readFileSync(captureFile, "utf8");
    expect(captured).toContain("PGHOST=::1\n");
    expect(captured).toContain("PGPORT=\n");
    expect(captured).toContain("PGUSER=\n");
    expect(captured).toContain("PGDATABASE=gittensory\n");
  });

  it("fails closed when Postgres metadata cannot be inspected", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const bin = failingPsql(root);

    expect(() =>
      runExporter(root, join(root, "unused.sqlite"), outDb, {
        DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      }),
    ).toThrow();
    expect(existsSync(outDb)).toBe(false);
  });

  it("cleans transient Postgres CSV files when COPY fails", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const bin = failingCopyPsql(root);
    const csvTmp = join(root, "csv temp");
    mkdirSync(csvTmp);

    expect(() =>
      runExporter(root, join(root, "unused.sqlite"), outDb, {
        DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: csvTmp,
      }),
    ).toThrow();
    expect(existsSync(outDb)).toBe(false);
    expect(readdirSync(csvTmp)).toEqual([]);
  });

  // ── Incremental fast-path (#3895) ──────────────────────────────────────────────────────────────────
  it("skips the rebuild on a second run when the SQLite source is unchanged", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE pull_requests (
        repo_full_name TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
        author_login TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pull_requests (repo_full_name, number, title, state, author_login, merged_at, created_at, updated_at)
      VALUES ('JSONbored/gittensory', 5001, 'unchanged PR', 'open', 'JSONbored', NULL, '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL, target_id TEXT NOT NULL, event_type TEXT NOT NULL, decision TEXT,
        source TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);

    const first = runExporter(root, appDb, outDb);
    expect(first).toContain("reporting export complete");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("1");

    const second = runExporter(root, appDb, outDb);
    expect(second).toContain("reporting export skipped: source unchanged since last export");
    // The last-good snapshot is untouched, not silently emptied or corrupted by the skip.
    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("1");
  });

  it("redoes the rebuild once the SQLite source actually changes, reflecting the new row", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE pull_requests (
        repo_full_name TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
        author_login TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pull_requests (repo_full_name, number, title, state, author_login, merged_at, created_at, updated_at)
      VALUES ('JSONbored/gittensory', 5002, 'first PR', 'open', 'JSONbored', NULL, '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z');

      CREATE TABLE review_audit (
        id TEXT NOT NULL, target_id TEXT NOT NULL, event_type TEXT NOT NULL, decision TEXT,
        source TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    runExporter(root, appDb, outDb);
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("1");

    sqlite(appDb, `
      INSERT INTO pull_requests (repo_full_name, number, title, state, author_login, merged_at, created_at, updated_at)
      VALUES ('JSONbored/gittensory', 5003, 'second PR', 'open', 'JSONbored', NULL, '2026-07-06T00:05:00Z', '2026-07-06T00:05:00Z');
    `);
    const second = runExporter(root, appDb, outDb);
    expect(second).toContain("reporting export complete");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("2");
  });

  it("skips the rebuild on a second run when the Postgres source is unchanged", () => {
    const root = tmpRoot();
    const outDb = join(root, "reporting.sqlite");
    const bin = fakePsql(root);
    const runOpts = { DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory", PATH: `${bin}:${process.env.PATH ?? ""}` };

    const first = runExporter(root, join(root, "unused.sqlite"), outDb, runOpts);
    expect(first).toContain("reporting export complete");

    const second = runExporter(root, join(root, "unused.sqlite"), outDb, runOpts);
    expect(second).toContain("reporting export skipped: source unchanged since last export");
    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT count(*) FROM review_targets;")).toBe("3");
  });
});
