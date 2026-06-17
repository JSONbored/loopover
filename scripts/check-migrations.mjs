#!/usr/bin/env node
// Guards the D1 migration set against the silent failure modes that git can't catch:
//   • two PRs that each grab the same next number (e.g. `0038_foo.sql` + `0038_bar.sql`) are DIFFERENT
//     files, so git reports no conflict and both merge — then `wrangler d1 migrations apply` runs both
//     in filename order and, if they touch the same column, errors mid-deploy.
//   • a skipped number (gap) or a stray non-conforming filename.
// Migration-only PRs trigger this via the `migrations/**` path filter in .github/workflows/ci.yml.
//
// KNOWN_DUPLICATES: two pairs (0015, 0017) already merged silently before this guard existed and are
// already applied in production — D1 records applied migrations by filename, so renaming either now would
// make wrangler try to re-apply it. They are grandfathered here. Do NOT add to this list; the whole point
// of the guard is that a NEW duplicate fails CI and gets renumbered before merge.
import { readdirSync } from "node:fs";

const DIR = "migrations";
const NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const KNOWN_DUPLICATES = new Map([
  [15, new Set(["0015_github_agent_command_feedback.sql", "0015_product_usage_events.sql"])],
  [17, new Set(["0017_agent_recommendation_outcomes.sql", "0017_product_usage_role_retention_rollups.sql"])],
]);

const fail = (message) => {
  process.stderr.write(`check-migrations: ${message}\n`);
  process.exit(1);
};

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

const first = String(numbers[0]).padStart(4, "0");
const last = String(numbers.at(-1)).padStart(4, "0");
process.stdout.write(`check-migrations: ${files.length} migrations OK — contiguous ${first}..${last} (2 grandfathered duplicates: 0015, 0017), no new duplicates. Next free: ${nextFree()}\n`);
