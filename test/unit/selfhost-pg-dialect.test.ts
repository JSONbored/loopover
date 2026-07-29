import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quoteCamelCaseAliases, stripConflictTargetQualifiers, toNumberedPlaceholders, translateDdl, translateFunctions, translateInsertOr, translateMigrationInserts, translateRowid, translateSql } from "../../src/selfhost/pg-dialect";

describe("pg-dialect (#977 SQLite → Postgres)", () => {
  it("numbers placeholders, skipping `?` inside string literals", () => {
    expect(toNumberedPlaceholders("SELECT * FROM t WHERE a=? AND b=?")).toBe("SELECT * FROM t WHERE a=$1 AND b=$2");
    expect(toNumberedPlaceholders("SELECT '?' AS lit WHERE a=?")).toBe("SELECT '?' AS lit WHERE a=$1");
  });

  it("REGRESSION: reuses a SQLite numbered placeholder's own index instead of corrupting it via the anonymous counter", () => {
    // Before the fix: `?1` scanned as anonymous `?` (→ $1) followed by a literal `1`, corrupting to `$11`
    // — a bind index Postgres has no value for. retentionWhere() (retention.ts) and claimRegateFanoutSlot()
    // (repositories.ts) both use this numbered syntax.
    expect(toNumberedPlaceholders("created_at < ?1")).toBe("created_at < $1");
    expect(toNumberedPlaceholders("last_regate_fanout_at = ?1 WHERE id = 'singleton' AND (x IS NULL OR x < ?2)")).toBe(
      "last_regate_fanout_at = $1 WHERE id = 'singleton' AND (x IS NULL OR x < $2)",
    );
    // A later anonymous `?` continues from the highest index already assigned (SQLite's own rule), so it
    // must not collide with an earlier numbered placeholder.
    expect(toNumberedPlaceholders("a=?1 AND b=?")).toBe("a=$1 AND b=$2");
    // A literal `?1` inside a string is left untouched, same as a bare `?` literal.
    expect(toNumberedPlaceholders("SELECT '?1' AS lit WHERE a=?")).toBe("SELECT '?1' AS lit WHERE a=$1");
  });

  it("translates datetime/strftime/CURRENT_TIMESTAMP/json to Postgres (text-returning to match SQLite)", () => {
    expect(translateFunctions("x > datetime('now', ?)")).toContain("to_char(now() + (?)::interval");
    expect(translateFunctions("datetime('now')")).toContain("to_char(now(),");
    expect(translateFunctions("strftime('%Y-W%W', created_at)")).toContain(`to_char((created_at)::timestamptz, 'YYYY"-W"WW')`);
    expect(translateFunctions("strftime('%Y-%m', created_at)")).toContain("'YYYY-MM'");
    expect(translateFunctions("CURRENT_TIMESTAMP")).toContain("to_char(now(),");
    expect(translateFunctions("json_extract(meta, '$.mode')")).toBe("((meta)::jsonb ->> 'mode')");
  });

  it("translates nested json_extract paths to #>> and date() to a TEXT day (#8171 — both previously silent self-host gaps)", () => {
    // Nested path: the persisted backtest runs read $.comparison.verdict — untranslated this is a hard
    // "function json_extract does not exist" error swallowed by the fail-safe trend reads.
    expect(translateFunctions("json_extract(metadata_json, '$.comparison.verdict')")).toBe("((metadata_json)::jsonb #>> '{comparison,verdict}')");
    expect(translateFunctions("json_extract(m, '$.a.b.c')")).toBe("((m)::jsonb #>> '{a,b,c}')");
    // date(): Postgres's implicit-cast date() returns a `date` node-pg parses into a JS Date object, so
    // every day-bucketed trend read bucketed NOTHING on self-host. TEXT parity with SQLite instead.
    expect(translateFunctions("SELECT date(created_at) AS day")).toBe("SELECT to_char((created_at)::timestamptz, 'YYYY-MM-DD') AS day");
    expect(translateFunctions("date(pr.merged_at)")).toBe("to_char((pr.merged_at)::timestamptz, 'YYYY-MM-DD')");
    expect(translateFunctions("WHERE date(t.first_seen) >= date(?)")).toBe("WHERE to_char((t.first_seen)::timestamptz, 'YYYY-MM-DD') >= to_char((?)::timestamptz, 'YYYY-MM-DD')");
    // datetime( must NOT match the date( rule, and an unrelated identifier ending in date( must survive.
    expect(translateFunctions("datetime('now')")).not.toContain("YYYY-MM-DD')");
    expect(translateFunctions("candidate(x)")).toBe("candidate(x)");
  });

  it("translates julianday() to a Julian Day NUMBER, preserving the ms arithmetic (#9648)", () => {
    // A single call → the numeric Julian Day, cast via ::timestamptz like the date()/strftime() rules.
    expect(translateFunctions("julianday(pr.merged_at)")).toBe("(EXTRACT(EPOCH FROM (pr.merged_at)::timestamptz) / 86400.0 + 2440587.5)");
    // Whitespace-tolerant.
    expect(translateFunctions("julianday(  pr.created_at  )")).toBe("(EXTRACT(EPOCH FROM (pr.created_at)::timestamptz) / 86400.0 + 2440587.5)");
    // The exact avgMergeMs expression from submitter-reputation.ts:421 — both calls translated, and the
    // `(a - b) * 86400000` still yields milliseconds (the +2440587.5 offsets cancel in the subtraction).
    const avgMergeMs = "(julianday(pr.merged_at) - julianday(pr.created_at)) * 86400000";
    const translated = translateFunctions(avgMergeMs);
    expect(translated).not.toMatch(/julianday/i);
    expect(translated).toBe(
      "((EXTRACT(EPOCH FROM (pr.merged_at)::timestamptz) / 86400.0 + 2440587.5) - (EXTRACT(EPOCH FROM (pr.created_at)::timestamptz) / 86400.0 + 2440587.5)) * 86400000",
    );
  });

  it("REGRESSION: listSubmitterCohortRows' statement has no remaining julianday after translateSql (#9648)", () => {
    // The full avgMergeMs SELECT column as it appears in src/review/submitter-reputation.ts (inline, not
    // exported) — translateSql must leave no SQLite-only julianday for Postgres to choke on.
    const statement =
      "SELECT AVG(CASE WHEN po.decision = 'merged' AND pr.merged_at IS NOT NULL THEN (julianday(pr.merged_at) - julianday(pr.created_at)) * 86400000 ELSE NULL END) AS avgMergeMs FROM review_audit po WHERE po.created_at >= datetime('now', ?)";
    expect(translateSql(statement)).not.toMatch(/julianday/i);
  });

  it("REGRESSION: translates json_each(col) array iteration to json_array_elements_text (crash-looped self-host Postgres boot, beta.9)", () => {
    // migrations/0191_linked_issue_claims.sql's backfill reads je.value after `FROM pull_requests pr,
    // json_each(pr.linked_issues_json) je` — untranslated, Postgres's own json_each() only accepts JSON
    // OBJECTS (and rejects a TEXT column outright: "function json_each(text) does not exist"), which crashed
    // the self-host Postgres migration runner in a boot loop in production. json_array_elements_text is the
    // array-expansion equivalent; the column alias list `(value)` keeps `je.value` readable unchanged.
    expect(translateFunctions("json_each(pr.linked_issues_json) je")).toBe("json_array_elements_text((pr.linked_issues_json)::json) AS je(value)");
    // The bare (no `AS`) alias form is what the migration actually uses; the `AS` form must also translate.
    expect(translateFunctions("json_each(col) AS alias")).toBe("json_array_elements_text((col)::json) AS alias(value)");
    expect(
      translateDdl(
        "INSERT INTO linked_issue_claims (repo_full_name, pull_number, issue_number, claimed_at)\n" +
          "SELECT pr.repo_full_name, pr.number, CAST(je.value AS INTEGER), pr.updated_at\n" +
          "FROM pull_requests pr, json_each(pr.linked_issues_json) je\n" +
          "WHERE pr.linked_issues_json != '[]';",
      ),
    ).toBe(
      "INSERT INTO linked_issue_claims (repo_full_name, pull_number, issue_number, claimed_at)\n" +
        "SELECT pr.repo_full_name, pr.number, CAST(je.value AS INTEGER), pr.updated_at\n" +
        "FROM pull_requests pr, json_array_elements_text((pr.linked_issues_json)::json) AS je(value)\n" +
        "WHERE pr.linked_issues_json != '[]';",
    );
  });

  it("REGRESSION: translates instr(haystack, needle) to Postgres's strpos (SQLite has no `instr` on Postgres)", () => {
    expect(translateFunctions("instr(x, '#')")).toBe("strpos(x, '#')");
    expect(translateFunctions("instr(ra.target_id, '#') > 0")).toBe("strpos(ra.target_id, '#') > 0");
  });

  it("REGRESSION: an instr() nested inside substr()/CAST() -- the actual shape public-stats.ts and contributor-gate-history-backfill.ts emit to parse a `repo#123` target_id -- translates end-to-end", () => {
    // public-stats.ts's exact pattern: extract the PR number after the `#`.
    const out = translateFunctions("CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS number");
    expect(out).toBe("CAST(substr(target_key, strpos(target_key, '#') + 1) AS INTEGER) AS number");
    // Two instr() calls in the same expression (repo name before the `#`, PR number after) both translate.
    const both = translateFunctions("substr(target_key, 1, instr(target_key, '#') - 1) AS repo, CAST(substr(target_key, instr(target_key, '#') + 1) AS INTEGER) AS number");
    expect(both).not.toMatch(/instr\(/i);
    expect(both).toContain("strpos(target_key, '#') - 1");
    expect(both).toContain("strpos(target_key, '#') + 1");
  });

  it("REGRESSION: quotes a bare camelCase AS alias so Postgres preserves its case instead of folding it to lowercase", () => {
    expect(quoteCamelCaseAliases("SELECT ra.target_id AS targetId FROM review_audit ra")).toBe('SELECT ra.target_id AS "targetId" FROM review_audit ra');
    expect(quoteCamelCaseAliases("pr.author_login AS authorLogin, ra.created_at AS createdAt")).toBe('pr.author_login AS "authorLogin", ra.created_at AS "createdAt"');
  });

  it("leaves an all-lowercase or snake_case alias untouched (already case-fold-safe on Postgres)", () => {
    expect(quoteCamelCaseAliases("SELECT a.project AS project, a.target_id AS target_id FROM a")).toBe("SELECT a.project AS project, a.target_id AS target_id FROM a");
  });

  it("never double-quotes an alias that's already quoted", () => {
    expect(quoteCamelCaseAliases('SELECT a.x AS "targetId" FROM a')).toBe('SELECT a.x AS "targetId" FROM a');
  });

  it("REGRESSION: translateSql composes alias-quoting with instr/strpos on the actual contributor-gate-history-backfill.ts query shape", () => {
    const out = translateSql(
      `SELECT ra.project AS project, ra.target_id AS targetId, ra.decision AS decision, ra.head_sha AS headSha,
              ra.source AS source, pr.author_login AS authorLogin, ra.created_at AS createdAt
         FROM review_audit ra
         LEFT JOIN pull_requests pr
           ON pr.repo_full_name = ra.project
          AND pr.number = CAST(substr(ra.target_id, instr(ra.target_id, '#') + 1) AS INTEGER)
        WHERE ra.event_type = 'gate_decision' AND instr(ra.target_id, '#') > 0`,
    );
    expect(out).toContain('AS "targetId"');
    expect(out).toContain('AS "headSha"');
    expect(out).toContain('AS "authorLogin"');
    expect(out).toContain('AS "createdAt"');
    expect(out).not.toMatch(/instr\(/i);
    expect(out).toContain("strpos(ra.target_id, '#')");
  });

  it("REGRESSION (#4997): a JSON-boolean json_extract comparison survives translation as text-to-text, not text-to-integer", () => {
    // findHottestInconclusiveReviewTargetForRepo (repositories.ts) compares a stored JSON boolean. SQLite's
    // json_extract surfaces a JSON boolean as the SQL integer 1/0, but Postgres's `->>` ALWAYS returns text --
    // comparing that text against a bare integer literal (the original `= 1`) throws a Postgres type-mismatch
    // error on every call. CAST to TEXT first so the comparison is valid on both backends.
    const translated = translateFunctions("CAST(json_extract(metadata_json, '$.inconclusive') AS TEXT) IN ('1', 'true')");
    expect(translated).toBe("CAST(((metadata_json)::jsonb ->> 'inconclusive') AS TEXT) IN ('1', 'true')");
    // No bare-integer comparison against a json_extract/->> expression should remain anywhere in the codebase --
    // this is the ONE call site, and it's fixed. (Documents the invariant the fix restores; not itself testing
    // translateFunctions with anything new.)
    expect(translated).not.toMatch(/->>\s*'[a-z]+'\s*\)?\s*=\s*\d/);
  });

  it("translates INSERT OR IGNORE / REPLACE to ON CONFLICT", () => {
    expect(translateInsertOr("INSERT OR IGNORE INTO t (a) VALUES (?)")).toBe("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING");
    const replace = translateInsertOr("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)");
    expect(replace).toContain("INSERT INTO system_flags");
    expect(replace).toContain("ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    expect(() => translateInsertOr("INSERT OR REPLACE INTO unknown_tbl (a) VALUES (?)")).toThrow(/no known conflict key/);
    expect(translateInsertOr("SELECT 1")).toBe("SELECT 1"); // passthrough
  });

  // #8382: src/ams/ingest.ts's live INSERT OR REPLACE threw "no known conflict key" on every self-host
  // Postgres deployment, failing the first AMS telemetry-ingest write outright. The statement below is the
  // one that module actually issues, verbatim.
  it("REGRESSION (#8382): translates the real ams_signals ingest INSERT OR REPLACE without throwing", () => {
    const translated = translateInsertOr(
      `INSERT OR REPLACE INTO ams_signals
           (instance_id, repo_hash, pr_hash, decision, reason_bucket, closed_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    );
    expect(translated).toContain("INSERT INTO ams_signals");
    // The conflict target must name the table's REAL constraint (UNIQUE (instance_id, pr_hash), migration
    // 0148) — a 3-column target would make Postgres reject the statement outright.
    expect(translated).toContain("ON CONFLICT (instance_id, pr_hash) DO UPDATE SET");
    // Key columns are excluded from the SET list; every non-key column is upserted.
    expect(translated).toContain("repo_hash=excluded.repo_hash");
    expect(translated).toContain("decision=excluded.decision");
    expect(translated).toContain("reason_bucket=excluded.reason_bucket");
    expect(translated).toContain("closed_at=excluded.closed_at");
    expect(translated).toContain("received_at=excluded.received_at");
    expect(translated).not.toContain("instance_id=excluded.instance_id");
    expect(translated).not.toContain("pr_hash=excluded.pr_hash");
  });

  // #8893: src/orb/ingest.ts's hourly ORB export issues this INSERT OR REPLACE; without a
  // REPLACE_CONFLICT_KEYS entry, translateInsertOr threw "no known conflict key" on the first
  // orb_reuse_counters write on every self-host Postgres deployment. The statement below is verbatim.
  it("REGRESSION (#8893): translates the real orb_reuse_counters ingest INSERT OR REPLACE without throwing", () => {
    const translated = translateInsertOr(
      `INSERT OR REPLACE INTO orb_reuse_counters (instance_id, day, hits, misses, received_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    );
    expect(translated).toContain("INSERT INTO orb_reuse_counters");
    // PRIMARY KEY (instance_id, day) — migration 0177 — is the conflict target.
    expect(translated).toContain("ON CONFLICT (instance_id, day) DO UPDATE SET");
    // Non-key columns are upserted; the key columns are excluded from the SET list.
    expect(translated).toContain("hits=excluded.hits");
    expect(translated).toContain("misses=excluded.misses");
    expect(translated).toContain("received_at=excluded.received_at");
    expect(translated).not.toContain("instance_id=excluded.instance_id");
    expect(translated).not.toContain("day=excluded.day");
  });

  it("translateSql composes all passes; translateDdl handles the ISO-now default", () => {
    expect(translateSql("SELECT * FROM t WHERE updated_at > datetime('now', ?)")).toMatch(/\$1/);
    expect(translateDdl("created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")).toContain("to_char(now() AT TIME ZONE 'UTC'");
  });

  it("translates an INSERT OR IGNORE seed embedded in a (multi-statement) migration file", () => {
    // The 0059_global_agent_controls seed — runSelfHostMigrations exec()s the whole file, so the
    // statement-anchored translateInsertOr can't reach this; translateMigrationInserts handles it.
    expect(translateMigrationInserts("INSERT OR IGNORE INTO global_agent_controls (id, frozen) VALUES ('singleton', 0);"))
      .toBe("INSERT INTO global_agent_controls (id, frozen) VALUES ('singleton', 0) ON CONFLICT DO NOTHING;");
    // Works mid-file alongside DDL, and leaves non-INSERT-OR statements untouched.
    const file = "CREATE TABLE t (a INTEGER);\nINSERT OR IGNORE INTO t (a) VALUES (1);\n";
    const out = translateMigrationInserts(file);
    expect(out).toContain("CREATE TABLE t (a INTEGER);");
    expect(out).toContain("INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING;");
    expect(translateMigrationInserts("CREATE TABLE t (a INTEGER);")).toBe("CREATE TABLE t (a INTEGER);"); // no-op
  });

  it("translateDdl applies INSERT OR IGNORE + function translation together", () => {
    const out = translateDdl("INSERT OR IGNORE INTO t (a, at) VALUES (1, CURRENT_TIMESTAMP);");
    expect(out).toContain("ON CONFLICT DO NOTHING");
    expect(out).toContain("to_char(now(),"); // CURRENT_TIMESTAMP still translated
    expect(out).not.toMatch(/INSERT\s+OR\s+IGNORE/i);
  });

  it("strips table qualifiers from an ON CONFLICT target (drizzle emits `\"t\".\"c\"`, which Postgres rejects)", () => {
    // The exact shape drizzle-orm/d1 emits for recordWebhookEvent — a table-qualified conflict target.
    expect(stripConflictTargetQualifiers('INSERT INTO "webhook_events" ("delivery_id") VALUES (?) ON CONFLICT ("webhook_events"."delivery_id") DO UPDATE SET "status" = ?'))
      .toBe('INSERT INTO "webhook_events" ("delivery_id") VALUES (?) ON CONFLICT ("delivery_id") DO UPDATE SET "status" = ?');
    // Multiple qualified conflict columns are each unqualified.
    expect(stripConflictTargetQualifiers('... ON CONFLICT ("t"."a", "t"."b") DO NOTHING')).toBe('... ON CONFLICT ("a", "b") DO NOTHING');
  });

  it("leaves an already-unqualified ON CONFLICT and a bare ON CONFLICT DO NOTHING untouched", () => {
    expect(stripConflictTargetQualifiers('ON CONFLICT ("key") DO UPDATE SET v=excluded.v')).toBe('ON CONFLICT ("key") DO UPDATE SET v=excluded.v');
    expect(stripConflictTargetQualifiers("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING")).toBe("INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING");
    expect(stripConflictTargetQualifiers("SELECT 1")).toBe("SELECT 1"); // no ON CONFLICT at all
  });

  it("only de-qualifies inside the conflict target — qualified refs elsewhere are preserved", () => {
    // The WHERE-clause qualifier must survive; only the ON CONFLICT target is rewritten.
    const out = stripConflictTargetQualifiers('UPDATE x SET "x"."a"=? WHERE "x"."id"=? ON CONFLICT ("x"."id") DO NOTHING');
    expect(out).toContain('"x"."a"=?');
    expect(out).toContain('WHERE "x"."id"=?');
    expect(out).toContain('ON CONFLICT ("id")');
  });

  it("translateSql de-qualifies the conflict target AND numbers placeholders (the real webhook upsert)", () => {
    const drizzle = 'insert into "webhook_events" ("delivery_id", "status") values (?, ?) on conflict ("webhook_events"."delivery_id") do update set "status" = ?';
    const out = translateSql(drizzle);
    expect(out).toContain('on conflict ("delivery_id")'); // qualifier stripped → valid Postgres
    expect(out).not.toContain('"webhook_events"."delivery_id"');
    expect(out).toContain("values ($1, $2)"); // placeholders numbered
    expect(out).toContain("set \"status\" = $3");
  });

  it("translates the rowid pseudo-column to Postgres's ctid system column", () => {
    expect(translateRowid("SELECT rowid FROM t WHERE a = ?")).toBe("SELECT ctid FROM t WHERE a = ?");
    expect(translateRowid("ORDER BY rowid DESC")).toBe("ORDER BY ctid DESC");
    expect(translateRowid("ORDER BY ROWID ASC")).toBe("ORDER BY ctid ASC"); // case-insensitive
    // Only the bare `rowid` token is rewritten — identifiers that merely contain it are left alone.
    expect(translateRowid("SELECT row_id, my_rowid_col FROM t")).toBe("SELECT row_id, my_rowid_col FROM t");
    expect(translateRowid("SELECT 1")).toBe("SELECT 1"); // no-op passthrough
  });

  it("REGRESSION (self-host Postgres prune-retention dead-letter): translateSql strips rowid from the exact batched-delete shape retention.ts emits", () => {
    // The literal shape src/db/retention.ts's pruneExpiredRecords() builds for its bounded batched delete.
    // Before the fix, this reached Postgres verbatim and failed with `column "rowid" does not exist`.
    const deleteSql = 'DELETE FROM ai_usage_events WHERE rowid IN (SELECT rowid FROM ai_usage_events WHERE created_at < ?1 LIMIT 1000)';
    const out = translateSql(deleteSql);
    expect(out.toLowerCase()).not.toContain("rowid");
    expect(out).toBe("DELETE FROM ai_usage_events WHERE ctid IN (SELECT ctid FROM ai_usage_events WHERE created_at < $1 LIMIT 1000)");
  });

  it("also fixes the rowid tie-break ORDER BY used by orb/relay.ts enrollment resolution", () => {
    const sql = "SELECT relay_mode FROM orb_enrollments WHERE installation_id = ? ORDER BY enrolled_at DESC, rowid DESC";
    const out = translateSql(sql);
    expect(out.toLowerCase()).not.toContain("rowid");
    expect(out).toContain("ORDER BY enrolled_at DESC, ctid DESC");
  });
});

describe("SQLite-only-function drift guard (#9648)", () => {
  // SQLite scalar functions with NO Postgres equivalent — each MUST be rewritten by translateSql before a
  // self-host Postgres deploy sees it. New app SQL using one of these without a translation rule is a silent
  // self-host break (untranslated → "function X does not exist"), exactly the class #8171/#9648 keep closing.
  const SQLITE_ONLY_FUNCTIONS = ["julianday", "unixepoch", "json_group_array", "json_array_length", "group_concat", "printf", "iif", "glob", "randomblob", "total"] as const;
  const callRe = (fn: string) => new RegExp(`\\b${fn}\\s*\\(`, "i");

  /** Strip TS comments (block + line) so the same words in English prose — "…their total (…)", a
   *  `review.exclude_paths` glob — are not mistaken for SQL. Runs before string-literal extraction. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  /** Every backtick/single/double-quoted string literal in a comment-stripped TS source file — the only place
   *  real SQL text lives. */
  function stringLiterals(source: string): string[] {
    return stripComments(source).match(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g) ?? [];
  }

  /** SQLite-only function names that appear in `sql` AND still appear after translateSql — i.e. would reach
   *  Postgres untranslated. Empty ⇒ every such call is covered by a translation rule. */
  function detectUntranslatedSqliteFunctions(sql: string): string[] {
    const translated = translateSql(sql);
    return SQLITE_ONLY_FUNCTIONS.filter((fn) => callRe(fn).test(sql) && callRe(fn).test(translated));
  }

  it("its detection helper flags a synthetic untranslated function (so the guard is not trivially green)", () => {
    // `unixepoch(` has no translation rule today, so a source line using it must be caught.
    expect(detectUntranslatedSqliteFunctions("SELECT unixepoch(created_at) FROM t")).toEqual(["unixepoch"]);
    // And the now-translated julianday must NOT be reported.
    expect(detectUntranslatedSqliteFunctions("SELECT julianday(created_at) FROM t")).toEqual([]);
  });

  it("no src/** SQL string literal uses a SQLite-only function without a translateSql rewrite", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || full === join("src", "selfhost", "pg-dialect.ts")) continue;
        for (const literal of stringLiterals(readFileSync(full, "utf8"))) {
          const untranslated = detectUntranslatedSqliteFunctions(literal);
          if (untranslated.length) offenders.push(`${full}: ${untranslated.join(", ")}`);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
