#!/usr/bin/env node
// Guards the D1 migration set against the silent failure modes that git can't catch:
//   • two PRs that each grab the same next number (e.g. `0038_foo.sql` + `0038_bar.sql`) are DIFFERENT
//     files, so git reports no conflict and both merge — then `wrangler d1 migrations apply` runs both
//     in filename order and, if they touch the same column, errors mid-deploy.
//   • a skipped number (gap) or a stray non-conforming filename.
// Migration-only PRs trigger this via the `migrations/**` path filter in .github/workflows/ci.yml.
//
// KNOWN_DUPLICATES: pairs already merged AND applied in production before the collision was noticed — D1
// records applied migrations by filename, so renaming either now would make wrangler (and the self-host
// migrator) try to RE-APPLY it. For a non-idempotent statement (e.g. `ALTER TABLE … ADD COLUMN`, which SQLite
// cannot guard with IF NOT EXISTS) the re-apply ERRORS and breaks the deploy, so renumbering is unsafe once the
// dup has shipped — those are grandfathered here. Do NOT add a NEW (not-yet-merged) duplicate to this list:
// renumber its branch to the next free number BEFORE merge. Only an already-shipped, can't-be-renumbered dup
// belongs here.
//   • 0015 / 0017 — predate the guard.
//   • 0074 — both 0074_ai_review_cache (#1462) and 0074_orb_self_enrollment_disabled (#1465, a bare ADD COLUMN)
//     merged + deployed before the collision surfaced; the column already exists in prod, so a rename would
//     re-run the ALTER and fail. Grandfathered for the same reason as 0015/0017.
import { readdirSync, readFileSync } from "node:fs";

const DIR = process.env.CHECK_MIGRATIONS_DIR || "migrations";
const NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const KNOWN_DUPLICATES = new Map([
  [15, new Set(["0015_github_agent_command_feedback.sql", "0015_product_usage_events.sql"])],
  [17, new Set(["0017_agent_recommendation_outcomes.sql", "0017_product_usage_role_retention_rollups.sql"])],
  [74, new Set(["0074_ai_review_cache.sql", "0074_orb_self_enrollment_disabled.sql"])],
]);

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
  [/create\s+(?:temp(?:orary)?\b|(?:table|index|view|trigger)\s+(?:if\s+not\s+exists\s+)?temp\s*\.)/gi, "temporary object (CREATE TEMP/TEMPORARY or temp schema) — D1 rejects temp tables/triggers/views/indexes; rewrite without one (e.g. DELETE the losers, then UPDATE the survivors)"],
  [/(?<=(?:^|;)\s*)attach\b/gi, "ATTACH is not supported on D1"],
  [/(?<=(?:^|;)\s*)detach\b/gi, "DETACH is not supported on D1"],
  [/(?<=(?:^|;)\s*)vacuum\b/gi, "VACUUM is not supported on D1"],
  [/(?<=(?:^|;)\s*)pragma\b/gi, "PRAGMA is not supported on D1"],
  [/(?<=(?:^|;)\s*)(?:begin|commit|rollback|savepoint|release)\b/gi, "explicit transaction control — wrangler wraps each migration in its own transaction"],
];

// Blank out comments and string/identifier literals (preserving newlines for accurate line numbers) so a
// forbidden keyword inside a comment or a quoted value can never trip a false positive.
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
    if (c === "'" || c === '"' || c === "`") {
      out += " ";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i += 1;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (c === "[") {
      out += " ";
      i += 1;
      while (i < sql.length && sql[i] !== "]") {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < sql.length) {
        out += " ";
        i += 1;
      }
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
  const number = Number(NAME.exec(file)[1]);
  if (!filesByNumber.has(number)) filesByNumber.set(number, []);
  filesByNumber.get(number).push(file);
}

const nextFree = () => {
  let n = Math.max(...filesByNumber.keys()) + 1;
  while (filesByNumber.has(n)) n += 1;
  return String(n).padStart(4, "0");
};

for (const [number, group] of filesByNumber) {
  if (group.length === 1) continue;
  const padded = String(number).padStart(4, "0");
  const allowed = KNOWN_DUPLICATES.get(number);
  const grandfathered = allowed && group.length === allowed.size && group.every((f) => allowed.has(f));
  if (!grandfathered) {
    fail(`duplicate migration number ${padded}: ${group.map((f) => `"${f}"`).join(", ")}. Two PRs grabbed the same number — renumber the newest to the next free number (${nextFree()}).`);
  }
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

const first = String(numbers[0]).padStart(4, "0");
const last = String(numbers.at(-1)).padStart(4, "0");
const grandfatheredNumbers = [...KNOWN_DUPLICATES.keys()]
  .sort((a, b) => a - b)
  .map((number) => String(number).padStart(4, "0"));
process.stdout.write(`check-migrations: ${files.length} migrations OK — contiguous ${first}..${last} (${grandfatheredNumbers.length} grandfathered duplicates: ${grandfatheredNumbers.join(", ")}), no new duplicates. Next free: ${nextFree()}\n`);
