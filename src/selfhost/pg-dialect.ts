// SQLite → Postgres SQL dialect translation for the self-host Postgres backend (#977). loopover's core and
// drizzle-orm/d1 emit SQLite-dialect SQL; this translates the bounded set of SQLite-isms the codebase uses
// (placeholders + a handful of scalar functions + INSERT OR REPLACE/IGNORE + the rowid pseudo-column) so
// the SAME queries run on Postgres. The timestamp columns are TEXT (ISO strings written by the app), so the
// datetime/CURRENT_TIMESTAMP translations return TEXT in SQLite's format to preserve the existing
// text-comparison semantics. Validated against a real Postgres (all 56 migrations + the runtime query paths).

// INSERT OR REPLACE needs an explicit conflict target on Postgres; map the (few) tables that use it to their PK.
const REPLACE_CONFLICT_KEYS: Record<string, string[]> = {
  system_flags: ["key"],
  tunables_overrides: ["project"],
  tunables_overrides_shadow: ["project"],
  orb_export_cursor: ["instance_hash"],
  orb_signals: ["instance_id", "repo_hash", "pr_hash"],
  // #8893: orb_reuse_counters (migrations/0177) is written with INSERT OR REPLACE by src/orb/ingest.ts; its
  // PRIMARY KEY (instance_id, day) is the conflict target the hourly ORB export needs on self-host Postgres.
  orb_reuse_counters: ["instance_id", "day"],
  // #9016: ai_review_verdict_flips (migrations/0183) is written with ON CONFLICT by recordVerdictFlip;
  // its PRIMARY KEY (repo_full_name, pull_number) is the conflict target on self-host Postgres.
  ai_review_verdict_flips: ["repo_full_name", "pull_number"],
  // ams_signals (#8382): TWO columns here, deliberately — this must name the table's REAL unique constraint
  // (`UNIQUE (instance_id, pr_hash)`, migrations/0148_ams_signals.sql), or Postgres rejects the generated
  // `ON CONFLICT` with "no unique or exclusion constraint matching". The 3-column shape orb_signals needed
  // (migrations/0060) buys nothing here: both tables are fed by the same exporter
  // (packages/loopover-miner/lib/orb-export.ts), which derives `prHash` from
  // `hmac(`${repoFullName}:${prNumber}`)` — the repo is INSIDE the pr_hash input, so within one instance a
  // pr_hash already identifies (repo, PR) and repo_hash is functionally determined by it. Two repos can
  // therefore never collide on (instance_id, pr_hash), and widening the key would need a table recreate for
  // zero uniqueness gain. Revisit only if pr_hash ever stops being repo-scoped at the producer.
  ams_signals: ["instance_id", "pr_hash"],
};

/** Replace `?` placeholders with `$1,$2,…`, skipping any `?` inside single-quoted string literals. A `?`
 *  immediately followed by digits is SQLite's *numbered* placeholder (`?1`, `?2`, …, e.g. retention.ts's
 *  `retentionWhere()` and repositories.ts's `claimRegateFanoutSlot()`) — its index is reused verbatim as
 *  `$1`/`$2` rather than folded into the anonymous-placeholder counter below, otherwise `?1` corrupts to
 *  `$1` + a literal trailing `1` (i.e. `$11`), which Postgres reads as bind parameter 11. Per SQLite's own
 *  rule, a later anonymous `?` gets "one greater than the largest parameter number already assigned", so a
 *  numbered placeholder also raises the anonymous counter's floor — otherwise a later `?` could collide with
 *  an earlier `?N` (e.g. `?1` then `?` must yield `$1`, `$2`, not `$1`, `$1`). */
export function toNumberedPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    if (ch === "'") inString = !inString;
    if (ch === "?" && !inString) {
      const numbered = /^\d+/.exec(sql.slice(i + 1))?.[0];
      if (numbered) {
        n = Math.max(n, Number(numbered));
        out += `$${numbered}`;
        i += numbered.length;
        continue;
      }
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Translate the SQLite scalar functions the codebase uses to Postgres equivalents. */
export function translateFunctions(sql: string): string {
  return translateInstr(
    sql
      // ISO-now (the DEFAULT on TEXT timestamp columns + nowIso parity)
      .replace(/strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi, `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
      // week / month buckets (stats)
      .replace(/strftime\(\s*'%Y-W%W'\s*,\s*([^)]+?)\s*\)/gi, `to_char(($1)::timestamptz, 'YYYY"-W"WW')`)
      .replace(/strftime\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, `to_char(($1)::timestamptz, 'YYYY-MM')`)
      // datetime('now', <modifier>) → TEXT in SQLite's 'YYYY-MM-DD HH:MM:SS' format (TEXT columns compared)
      .replace(/datetime\(\s*'now'\s*,\s*([^)]+?)\s*\)/gi, `to_char(now() + ($1)::interval, 'YYYY-MM-DD HH24:MI:SS')`)
      .replace(/datetime\(\s*'now'\s*\)/gi, `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`)
      // CURRENT_TIMESTAMP → SQLite's TEXT format (the columns are TEXT)
      .replace(/CURRENT_TIMESTAMP/gi, `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`)
      // julianday(<expr>) → the Julian Day NUMBER as a numeric, so `(julianday(a) - julianday(b)) * 86400000`
      // still yields milliseconds (submitter-reputation.ts's avgMergeMs, #9648). ::timestamptz matches the
      // date()/strftime() rules so the TEXT ISO timestamps the app writes are interpreted identically.
      .replace(/julianday\(\s*([^)]+?)\s*\)/gi, `(EXTRACT(EPOCH FROM ($1)::timestamptz) / 86400.0 + 2440587.5)`)
      // date(<expr>) → TEXT 'YYYY-MM-DD' like SQLite's date(). Postgres would accept date(<text>) via an
      // implicit cast, but it returns a `date`-typed value that node-pg parses into a JS Date object — so
      // every day-bucketed trend read (rule-calibration-trend.ts, public-accuracy-trend.ts, stats.ts, ...)
      // silently bucketed NOTHING on self-host: the JS-side week matching expects the TEXT day D1 returns
      // (#8171). `datetime(` cannot match (the regex requires "(" immediately after "date").
      .replace(/(?<![\w$])date\(\s*([A-Za-z0-9_.]+|\?)\s*\)/gi, `to_char(($1)::timestamptz, 'YYYY-MM-DD')`)
      // json_extract(col, '$.a.b…') (nested paths) → (col::jsonb #>> '{a,b…}') — the persisted backtest runs
      // read `$.comparison.verdict`, which the single-level rule below can't see; untranslated it is a hard
      // "function json_extract does not exist" error swallowed by the fail-safe trend reads (#8171).
      .replace(/json_extract\(\s*([^,]+?)\s*,\s*'\$\.((?:[A-Za-z0-9_]+\.)+[A-Za-z0-9_]+)'\s*\)/gi, (_m, col, path) => `((${col})::jsonb #>> '{${path.split(".").join(",")}}')`)
      // json_extract(col, '$.key') → (col::jsonb ->> 'key')  (single-level paths)
      .replace(/json_extract\(\s*([^,]+?)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi, `(($1)::jsonb ->> '$2')`)
      // json_each(col) alias → SQLite's json_each() on a JSON ARRAY yields one row per element with a
      // `value` column (migrations/0191's linked-issue-claims backfill reads je.value); untranslated on
      // Postgres, json_each() there decomposes JSON OBJECTS only and rejects a bare TEXT column outright
      // ("function json_each(text) does not exist"), crash-looping the self-host Postgres migration runner
      // on startup. json_array_elements_text is Postgres's array-expansion equivalent — cast the column to
      // `json` and alias the single output column back to `value` so `je.value` keeps working unchanged.
      .replace(/\bjson_each\(\s*([^()]+?)\s*\)\s*(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi, (_m, col, alias) => `json_array_elements_text((${col})::json) AS ${alias}(value)`)
      // instr(haystack, needle) → strpos(haystack, needle): both are 1-based first-occurrence index, 0 if
      // absent -- a direct semantic match, no formula adjustment needed. Postgres has no `instr` builtin at
      // all (unlike substr, which is SQL-standard and needs no translation) -- every instr() call reaching
      // Postgres untranslated fails outright with "function instr(...) does not exist", which the codebase's
      // fail-safe read paths (e.g. computeContributorGateEval-style try/catch) silently swallow to an empty
      // result rather than surfacing. Used to parse a `repo#123`-shaped target_id/target_key in several
      // review/public-stats query builders (e.g. public-stats.ts, contributor-gate-history-backfill.ts).
      //
      // #9084: done with a paren-balanced scan rather than a regex. The previous `instr\(\s*([^,]+?)...` rule
      // stopped its haystack at the first comma, so a NESTED call -- `instr(substr(a, instr(a, '#') + 1), '#')`,
      // the natural way to ask about a second separator -- left the outer `instr(` untranslated, producing SQL
      // that fails on Postgres with the exact "function instr does not exist" this rule exists to prevent, and
      // the failure lands in a fail-safe read path that swallows it to an empty result. Nothing in the codebase
      // nests instr today; this makes sure the first thing that does is not silently broken on the self-host.
  );
}

/**
 * Rewrite every `instr(haystack, needle)` to `strpos(haystack, needle)`, including nested occurrences.
 *
 * Scans for the top-level comma with a depth counter, skipping over single-quoted literals so a comma or paren
 * inside a string can never be mistaken for structure. Innermost calls translate first (the recursion runs on
 * the extracted arguments), so nesting depth is unbounded. A malformed call with no balanced close paren or no
 * top-level comma is left exactly as written -- this is a mechanical translator, not a validator, and mangling
 * SQL it does not understand would be worse than passing it through.
 */
export function translateInstr(sql: string): string {
  const lower = sql.toLowerCase();
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf("instr(", cursor);
    // Only a call boundary counts -- `myinstr(` and `x.instr(` are somebody else's identifier.
    if (start === -1) {
      out += sql.slice(cursor);
      return out;
    }
    const prev = start > 0 ? sql[start - 1]! : "";
    if (/[A-Za-z0-9_$.]/.test(prev)) {
      out += sql.slice(cursor, start + "instr(".length);
      cursor = start + "instr(".length;
      continue;
    }
    const open = start + "instr(".length;
    let depth = 1;
    let quoted = false;
    let comma = -1;
    let index = open;
    for (; index < sql.length; index += 1) {
      const char = sql[index]!;
      if (quoted) {
        if (char === "'") quoted = false;
        continue;
      }
      if (char === "'") quoted = true;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (char === "," && depth === 1 && comma === -1) comma = index;
    }
    if (depth !== 0 || comma === -1) {
      out += sql.slice(cursor, open);
      cursor = open;
      continue;
    }
    const haystack = translateInstr(sql.slice(open, comma).trim());
    const needle = translateInstr(sql.slice(comma + 1, index).trim());
    out += `${sql.slice(cursor, start)}strpos(${haystack}, ${needle})`;
    cursor = index + 1;
  }
}

/** Quote a bare camelCase `AS` alias so Postgres preserves its case. Unquoted identifiers are case-folded to
 *  lowercase by Postgres (both at DEFINITION and at SELECT-list ALIAS time) -- SQLite/D1 preserves whatever
 *  case the query wrote. The codebase's query builders read result rows by camelCase property access
 *  (`row.targetId`, `row.authorLogin`, ...) expecting the alias verbatim; unquoted on Postgres, `AS targetId`
 *  comes back as the key `targetid`, so every such field silently reads as `undefined` -- a fail-safe read
 *  path (try/catch → empty result) swallows this without ever surfacing an error. Only bare (unquoted, no
 *  leading digit) aliases containing at least one uppercase letter need quoting; an all-lowercase or
 *  already-quoted alias is left untouched. Scoped to `AS <ident>` specifically (never a plain column/table
 *  reference elsewhere) since that's the only place this codebase's queries introduce a camelCase name. */
export function quoteCamelCaseAliases(sql: string): string {
  return sql.replace(/\bAS\s+([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g, (_full, ident: string) => `AS "${ident}"`);
}

/** Translate SQLite's `rowid` pseudo-column to Postgres's `ctid` system column. Both give a stable,
 *  per-row identifier for the lifetime of a single statement/snapshot — exactly how the codebase uses
 *  it: `DELETE ... WHERE rowid IN (SELECT rowid FROM t WHERE ... LIMIT n)` for bounded batched pruning
 *  (retention.ts) and `ORDER BY rowid` for insertion-order tie-breaking (orb/relay.ts, tests). `ctid` is
 *  a *physical* row location that can change across `VACUUM FULL` / row rewrites, so this is only safe
 *  for the codebase's existing usage — internal bookkeeping resolved within one statement — never for
 *  durable application-facing row identity. Fixes the self-host Postgres dead-letter where the raw
 *  `rowid` reached Postgres verbatim ("column \"rowid\" does not exist"). */
export function translateRowid(sql: string): string {
  return sql.replace(/\browid\b/gi, "ctid");
}

/** Translate INSERT OR REPLACE / INSERT OR IGNORE to Postgres ON CONFLICT. */
export function translateInsertOr(sql: string): string {
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    return `${sql.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO/i, "$1INSERT INTO")} ON CONFLICT DO NOTHING`;
  }
  const m = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)/i.exec(sql);
  if (m) {
    const table = m[1] as string;
    const cols = (m[2] as string).split(",").map((c) => c.trim());
    const pk = REPLACE_CONFLICT_KEYS[table];
    if (!pk) throw new Error(`pg_dialect: INSERT OR REPLACE into '${table}' has no known conflict key`);
    const updates = cols
      .filter((c) => !pk.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(", ");
    const base = sql.replace(/^(\s*)INSERT\s+OR\s+REPLACE\s+INTO/i, "$1INSERT INTO");
    return `${base} ON CONFLICT (${pk.join(", ")}) DO UPDATE SET ${updates}`;
  }
  return sql;
}

/** Strip table qualifiers from an ON CONFLICT target list. drizzle-orm/d1 emits the conflict target as
 *  `ON CONFLICT ("table"."col")` — valid in SQLite, but Postgres requires an unqualified column list
 *  (`ON CONFLICT ("col")`) and otherwise fails with a syntax error, breaking every Drizzle upsert
 *  (e.g. recordWebhookEvent → webhook ingest) on the Postgres backend. Scoped to the conflict-target
 *  parens so qualified column refs elsewhere (WHERE / SELECT / joins) are left intact. */
export function stripConflictTargetQualifiers(sql: string): string {
  // Capture the keyword + opening paren and the closing paren so the original casing/spacing is preserved
  // (drizzle emits lowercase `on conflict`); only the inner target list is rewritten.
  return sql.replace(
    /(\bON\s+CONFLICT\s*\()([^)]*)(\))/gi,
    (_full, open: string, target: string, close: string) => `${open}${target.replace(/"[^"]+"\s*\.\s*("[^"]+")/g, "$1")}${close}`,
  );
}

/** Translate a runtime query (SQLite → Postgres). */
export function translateSql(sql: string): string {
  return toNumberedPlaceholders(stripConflictTargetQualifiers(translateRowid(quoteCamelCaseAliases(translateFunctions(translateInsertOr(sql))))));
}

/** Migrations are applied as whole multi-statement files via exec(), so the statement-anchored
 *  translateInsertOr() can't reach an `INSERT OR IGNORE` embedded mid-file (e.g. the global_agent_controls
 *  seed in 0059). Rewrite each such statement to Postgres `INSERT … ON CONFLICT DO NOTHING`. Only IGNORE
 *  seeds exist in migrations; an INSERT OR REPLACE statement would need a known conflict key, so it is left
 *  untouched (and would surface as a clear Postgres error) rather than guessed at. */
export function translateMigrationInserts(sql: string): string {
  return sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO\b([^;]*);/gi, "INSERT INTO$1 ON CONFLICT DO NOTHING;");
}

/**
 * SQLite's auto-assigning surrogate key, rendered as its Postgres equivalent (#10138).
 *
 * `INTEGER PRIMARY KEY AUTOINCREMENT` is a hard Postgres PARSE error -- `syntax error at or near
 * "AUTOINCREMENT"`, SQLSTATE 42601 -- so a migration containing it aborts runSelfHostMigrations and the Orb
 * crash-loops on boot. That is what 0209 did: every Orb upgrading past 0208 failed to start.
 *
 * Stripping the keyword alone would be WORSE, not better. A bare `INTEGER PRIMARY KEY` is auto-assigning in
 * SQLite (it aliases the rowid) but is an ordinary NOT NULL integer column in Postgres, so the DDL would
 * parse and then every insert that omits the id -- which is every insert, that being the point of a
 * surrogate key -- would fail its NOT NULL constraint at RUNTIME instead. On a best-effort writer that
 * swallows errors (service_status_samples is exactly that) it would fail silently and simply record
 * nothing. Trading a loud boot failure for a silent data-loss failure is not a fix.
 *
 * `BY DEFAULT` rather than `ALWAYS`: SQLite permits an explicit id on insert, and `ALWAYS` would reject one,
 * which would change behaviour for any caller that supplies its own key. `BIGINT` matches SQLite's 64-bit
 * rowid rather than narrowing it to int4.
 *
 * Only the canonical `INTEGER PRIMARY KEY AUTOINCREMENT` spelling is translated. A stray `AUTOINCREMENT` in
 * some other shape stays untranslated and surfaces as a clear Postgres syntax error -- the same deliberate
 * stance translateMigrationInserts takes with `INSERT OR REPLACE`: fail visibly rather than guess at intent.
 */
export function translateAutoincrementPrimaryKey(sql: string): string {
  return sql.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
}

/** Translate a DDL statement (migrations). Column types (TEXT/INTEGER/REAL) are PG-native; the SQLite
 *  default expressions need translating, as does any `INSERT OR IGNORE` seed and any AUTOINCREMENT surrogate
 *  key (#10138 -- a CONSTRAINT rather than a type, which is why the "types are PG-native" note above did not
 *  cover it). No `?` placeholders in DDL. */
export function translateDdl(sql: string): string {
  return translateAutoincrementPrimaryKey(translateFunctions(translateMigrationInserts(sql)));
}
