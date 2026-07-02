#!/usr/bin/env -S npx --no-install tsx
// Guards the D1 migration set against the silent failure modes that git can't catch:
//   • two PRs that each grab the same next number (e.g. `0038_foo.sql` + `0038_bar.sql`) are DIFFERENT
//     files, so git reports no conflict and both merge — then `wrangler d1 migrations apply` runs both
//     in filename order and, if they touch the same column, errors mid-deploy.
//   • a skipped number (gap) or a stray non-conforming filename.
// Migration-only PRs trigger this via the `migrations/**` path filter in .github/workflows/ci.yml.
//
// Run via `tsx` (not plain `node`), not for style but because this script's number/duplicate-detection logic
// is imported from src/db/migration-collisions.ts (#2550) — the SAME pure module the live premerge recheck
// uses inside the Worker, so CI and the Worker can never disagree about what counts as a collision. Plain
// `node` cannot resolve a `.ts` import without a flag CI's pinned Node version isn't guaranteed to support;
// `tsx` is already an established devDependency for exactly this (see ui:openapi/selfhost:postgres:migrate).
//
// KNOWN_MIGRATION_DUPLICATES (src/db/migration-collisions.ts): pairs already merged AND applied in production
// before the collision was noticed — D1 records applied migrations by filename, so renaming either now would
// make wrangler (and the self-host migrator) try to RE-APPLY it. For a non-idempotent statement (e.g.
// `ALTER TABLE … ADD COLUMN`, which SQLite cannot guard with IF NOT EXISTS) the re-apply ERRORS and breaks the
// deploy, so renumbering is unsafe once the dup has shipped — those are grandfathered there. Do NOT add a NEW
// (not-yet-merged) duplicate: renumber its branch to the next free number BEFORE merge. Only an
// already-shipped, can't-be-renumbered dup belongs there.
//   • 0015 / 0017 — predate the guard.
//   • 0074 — both 0074_ai_review_cache (#1462) and 0074_orb_self_enrollment_disabled (#1465, a bare ADD COLUMN)
//     merged + deployed before the collision surfaced; the column already exists in prod, so a rename would
//     re-run the ALTER and fail. Grandfathered for the same reason as 0015/0017.
//   • 0090 — both 0090_contributor_cap_label (#2479) and 0090_pull_request_detail_sync_head_sha (#2527)
//     merged with bare ADD COLUMN statements. Preserve both filenames so already-applied databases never
//     replay either ALTER under a new migration name.
import { readdirSync, readFileSync } from "node:fs";
import { detectMigrationCollisions, extractMigrationNumber, KNOWN_MIGRATION_DUPLICATES, MIGRATION_FILENAME_PATTERN } from "../src/db/migration-collisions.ts";
import { detectColumnCollisions } from "../src/db/migration-column-extraction.ts";

const DIR = process.env.CHECK_MIGRATIONS_DIR || "migrations";
const NAME = MIGRATION_FILENAME_PATTERN;
const KNOWN_DUPLICATES = KNOWN_MIGRATION_DUPLICATES;

const fail = (message) => {
  process.stderr.write(`check-migrations: ${message}\n`);
  process.exit(1);
};

// D1 remote-authorizer compatibility. These statements run fine on the LOCAL SQLite that CI/tests apply
// migrations to, but the REMOTE D1 authorizer rejects them at `wrangler d1 migrations apply --remote` with
// `not authorized: SQLITE_AUTH [code: 7500]` — which breaks the deploy AFTER merge, where pre-merge CI can't
// see it (a `CREATE TEMP TABLE` in 0083 did exactly this). This scan is the only pre-merge gate for that class.
// `CREATE TEMP` and `CREATE <object> temp.<name>` match anywhere (they always start a statement);
// the rest anchor to a statement boundary (start-of-file or after a `;`) so a trigger body's own
// `BEGIN`/`END` and mid-statement words don't trip.
// The anchored patterns use a variable-length lookbehind (`(?<=(?:^|;)\s*)`, supported by V8/Node) so the
// match starts on the keyword itself — reported line numbers point at the statement, not the preceding `;`.
const D1_FORBIDDEN = [
  [/create\s+(?:temp(?:orary)?\b|(?:unique\s+)?(?:table|index|view|trigger)\s+(?:if\s+not\s+exists\s+)?temp\s*\.)/gi, "temporary object (CREATE TEMP/TEMPORARY or temp schema) — D1 rejects temp tables/triggers/views/indexes; rewrite without one (e.g. DELETE the losers, then UPDATE the survivors)"],
  [/(?<=(?:^|;)\s*)attach\b/gi, "ATTACH is not supported on D1"],
  [/(?<=(?:^|;)\s*)detach\b/gi, "DETACH is not supported on D1"],
  [/(?<=(?:^|;)\s*)vacuum\b/gi, "VACUUM is not supported on D1"],
  [/(?<=(?:^|;)\s*)pragma\b/gi, "PRAGMA is not supported on D1"],
  [/(?<=(?:^|;)\s*)(?:begin|commit|rollback|savepoint|release)\b/gi, "explicit transaction control — wrangler wraps each migration in its own transaction"],
];

// Blank out comments and quoted VALUES (preserving newlines for accurate line numbers) so a forbidden
// keyword inside a comment or a quoted value can never trip a false positive. A quoted token used as a
// schema-qualifying IDENTIFIER is different: `"temp".scratch`, `` `temp`.scratch ``, `[temp].scratch`, and
// even `'temp'.scratch` (SQLite's documented single-quote-as-identifier fallback) are exactly as much a
// temp-schema object as unquoted `temp.scratch` and must not be hidden from D1_FORBIDDEN below. But the
// temp-schema pattern is deliberately UNANCHORED (it must match anywhere a statement can start), so
// preserving a quoted token's content unconditionally — merely because ITS quote style is capable of
// being an identifier — would leak an ordinary column/table NAME's text into that scan too, e.g. a column
// literally named "create temp note" is not a temp-schema reference. An identifier is only ever
// schema-qualifying something when its closing quote is immediately followed (past optional whitespace)
// by a `.`; an ordinary name or value never is. Peeking past the closing quote for one, uniformly across
// all four quoting styles, distinguishes "used as a schema qualifier" from "used as a name or value"
// without a real SQL parser.
function cleanSql(sql) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      out += "  ";
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < sql.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let content = "";
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            content += close;
            j += 2;
            continue;
          }
          break;
        }
        content += sql[j];
        j += 1;
      }
      let k = j + 1;
      while (k < sql.length && /\s/.test(sql[k])) k += 1;
      const usedAsSchemaQualifier = k < sql.length && sql[k] === ".";
      out += " ";
      for (const ch of content) out += usedAsSchemaQualifier ? ch : ch === "\n" ? "\n" : " ";
      if (j < sql.length) out += " ";
      i = j < sql.length ? j + 1 : j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (files.length === 0) fail(`no .sql migrations found in ${DIR}/`);

const malformed = files.filter((f) => !NAME.test(f));
if (malformed.length > 0) {
  fail(`migration filenames must be NNNN_snake_case.sql (4-digit zero-padded number): ${malformed.join(", ")}`);
}

const filesByNumber = new Map();
for (const file of files) {
  const number = extractMigrationNumber(file);
  if (!filesByNumber.has(number)) filesByNumber.set(number, []);
  filesByNumber.get(number).push(file);
}

const nextFree = () => {
  let n = Math.max(...filesByNumber.keys()) + 1;
  while (filesByNumber.has(n)) n += 1;
  return String(n).padStart(4, "0");
};

// #2550: the actual duplicate-vs-grandfathered decision runs through detectMigrationCollisions, the SAME
// pure function the live premerge recheck uses — this is not just the equivalent logic re-derived here, it
// is the identical import, so CI and the Worker can never silently disagree about what counts as a collision.
const collisions = detectMigrationCollisions(files, KNOWN_DUPLICATES);
if (collisions.length > 0) {
  const { paddedNumber, files: group } = collisions[0];
  fail(`duplicate migration number ${paddedNumber}: ${group.map((f) => `"${f}"`).join(", ")}. Two PRs grabbed the same number — renumber the newest to the next free number (${nextFree()}).`);
}

const numbers = [...filesByNumber.keys()].sort((a, b) => a - b);
for (let i = 1; i < numbers.length; i += 1) {
  if (numbers[i] !== numbers[i - 1] + 1) {
    const prev = String(numbers[i - 1]).padStart(4, "0");
    const curr = String(numbers[i]).padStart(4, "0");
    fail(`migration number gap: ${prev} -> ${curr}. Migrations must be a contiguous sequence (no skipped numbers).`);
  }
}

const sqlViolations = [];
for (const file of files) {
  const cleaned = cleanSql(readFileSync(`${DIR}/${file}`, "utf8"));
  for (const [re, why] of D1_FORBIDDEN) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(cleaned)) !== null) {
      const line = cleaned.slice(0, match.index).split("\n").length;
      sqlViolations.push(`${file}:${line} — ${why}`);
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
  }
}
if (sqlViolations.length > 0) {
  fail(
    `D1-incompatible SQL — the remote D1 authorizer rejects these at deploy (SQLITE_AUTH [code: 7500]), even though the local SQLite used by CI accepts them:\n  ${sqlViolations.join("\n  ")}`,
  );
}

// #2551: two DIFFERENT, individually-valid migration numbers can each add the SAME column to the SAME
// table — different files, no git conflict, both pass the number-collision check above, and both show
// `mergeable_state: clean` — only failing at actual `wrangler d1 migrations apply` deploy time, after merge,
// with zero prior CI signal. `files` is already numerically sorted (4-digit zero-padded lexicographic sort),
// which detectColumnCollisions requires so a documented DROP TABLE + CREATE TABLE recreate (e.g.
// migrations/0060_orb_fleet_collector.sql's orb_signals) correctly clears the table it replaces instead of
// reading as a collision with it.
const columnCollisions = detectColumnCollisions(files.map((file) => [file, readFileSync(`${DIR}/${file}`, "utf8")]));
if (columnCollisions.length > 0) {
  const { table, column, files: group } = columnCollisions[0];
  fail(
    `duplicate column ${table}.${column} defined by more than one migration: ${group.map((f) => `"${f}"`).join(", ")}. Two migrations independently added the same column under different numbers — this passes CI and shows a clean merge state, but fails at "wrangler d1 migrations apply" deploy time. Rename or remove the newer migration's column (or confirm the table is DROPped and recreated before it).`,
  );
}

const first = String(numbers[0]).padStart(4, "0");
const last = String(numbers.at(-1)).padStart(4, "0");
const grandfatheredNumbers = [...KNOWN_DUPLICATES.keys()]
  .sort((a, b) => a - b)
  .map((number) => String(number).padStart(4, "0"));
process.stdout.write(`check-migrations: ${files.length} migrations OK — contiguous ${first}..${last} (${grandfatheredNumbers.length} grandfathered duplicates: ${grandfatheredNumbers.join(", ")}), no new duplicates. Next free: ${nextFree()}\n`);
