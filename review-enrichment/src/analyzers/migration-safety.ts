// SQL migration-safety linter (#2022). Flags risky schema operations in ADDED migration SQL — the changes that
// can break running deployments mid-rollout: dropping/truncating tables or columns the old code still reads,
// renames (the old code's names disappear), non-nullable columns added without a DEFAULT (inserts from old code
// fail), SET NOT NULL on existing nullable columns without a same-line DEFAULT, column-type changes that force
// a blocking table rewrite, and non-concurrent index builds that lock writers. Pure compute over added patch lines in migration
// paths — no network, no SQL parsing beyond single-line statement shapes. Detection is deliberately
// line-anchored: a statement split across lines is missed (fail-quiet) rather than tracked with cross-line
// state, and each shape is a finite, documented DDL form — never a general SQL grammar.
import type { EnrichRequest, MigrationSafetyFinding } from "../types.js";

const MAX_FINDINGS = 20;
const MAX_LINE_CHARS = 2000;

// Migration SQL locations: a migrations/ directory (Wrangler/D1, Prisma, Flyway, …), Rails-style db/migrate/,
// or any .sql file — the three forms named by #2022.
const MIGRATION_PATH_RE = /(?:^|\/)(?:migrations?|db\/migrate)\/|\.sql$/i;

// Dropping a table or column breaks any still-deployed reader/writer of the old schema.
const DROP_RE = /\bDROP\s+(?:TABLE|COLUMN)\b/i;
// TRUNCATE wipes live rows; still-running code that reads the table sees empty data mid-rollout.
const TRUNCATE_RE = /\bTRUNCATE\b/i;
// Renames remove the old name in one step; running code that still uses it fails immediately. Covers the
// standard forms: `ALTER TABLE a RENAME TO b`, `… RENAME [COLUMN] x TO y` (PostgreSQL/SQLite treat the
// COLUMN keyword as optional), and MySQL's `RENAME TABLE a TO b`.
const RENAME_RE = /\b(?:RENAME\s+TABLE\b|RENAME\s+(?:COLUMN\s+)?\S+\s+TO\b|RENAME\s+TO\b)/i;
// `ADD [COLUMN] … NOT NULL` without a DEFAULT on the same line: inserts from not-yet-updated code omit the
// column and fail. The lookahead keeps `ADD CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK/INDEX/KEY …` out — those
// are not column additions even when their line also contains `NOT NULL` (e.g. a CHECK on nullability).
const ADD_COLUMN_RE =
  /\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|FOREIGN\b|UNIQUE\b|CHECK\b|INDEX\b|KEY\b)(?:COLUMN\s+)?\S/i;
const NOT_NULL_RE = /\bNOT\s+NULL\b/i;
const DEFAULT_RE = /\bDEFAULT\b/i;
// Promoting an existing nullable column to NOT NULL without a same-line DEFAULT/backfill: rows that still
// contain NULL fail the constraint check when the migration runs.
const SET_NOT_NULL_RE = /\bSET\s+NOT\s+NULL\b/i;
// Column-type changes rewrite (and lock) the whole table in most engines: Postgres
// `ALTER COLUMN x [SET DATA] TYPE …` and MySQL `MODIFY [COLUMN] …`.
const BLOCKING_REWRITE_RE =
  /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b|\bMODIFY\s+(?:COLUMN\s+)?\S/i;
// A non-concurrent index build locks the table for writes (and often reads) until it finishes.
const CREATE_INDEX_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
const CONCURRENTLY_RE = /\bCONCURRENTLY\b/i;

/** Classify one added migration-SQL line (after `--` comment stripping). Pure. */
export function classifyMigrationLine(
  body: string,
): MigrationSafetyFinding["kind"] | null {
  if (DROP_RE.test(body)) return "drop";
  if (RENAME_RE.test(body)) return "rename";
  if (TRUNCATE_RE.test(body)) return "truncate";
  if (
    ADD_COLUMN_RE.test(body) &&
    NOT_NULL_RE.test(body) &&
    !DEFAULT_RE.test(body)
  ) {
    return "not-null-no-default";
  }
  if (
    SET_NOT_NULL_RE.test(body) &&
    !ADD_COLUMN_RE.test(body) &&
    !DEFAULT_RE.test(body)
  ) {
    return "set-not-null";
  }
  if (BLOCKING_REWRITE_RE.test(body)) return "blocking-rewrite";
  if (CREATE_INDEX_RE.test(body) && !CONCURRENTLY_RE.test(body)) {
    return "blocking-index";
  }
  return null;
}

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Whether `path` is a migration SQL location this linter should scan. Pure. */
export function isMigrationPath(path: string): boolean {
  return MIGRATION_PATH_RE.test(path);
}

function pushFinding(
  findings: MigrationSafetyFinding[],
  seen: Set<string>,
  file: string,
  line: number,
  kind: MigrationSafetyFinding["kind"],
  maxFindings: number,
): boolean {
  const key = `${kind}:${line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  findings.push({ file, line, kind });
  return findings.length >= maxFindings;
}

/** Scan one migration file's patch for risky schema statements on ADDED lines. Pure. */
export function scanPatchForMigrationSafety(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): MigrationSafetyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const findings: MigrationSafetyFinding[] = [];
  const seen = new Set<string>();
  let newLine = 0;
  let inHunk = false;

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (!line.startsWith("+")) {
      // A `\ No newline at end of file` marker is not a content line, so it must not advance the
      // new-file line counter — mirrors the sibling analyzers (e.g. iac-misconfig.ts).
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const rawBody = line.slice(1);
    if (rawBody.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }
    // Strip the trailing `--` SQL line comment before EVERY rule check: a full-comment line
    // (`-- DROP TABLE users (old cleanup)`) must not be flagged, and a trailing comment must not vouch for
    // the statement either (`ADD COLUMN age INTEGER NOT NULL; -- DEFAULT later` has no real DEFAULT).
    // Block comments are not tracked (no cross-line state by design).
    const body = rawBody.replace(/--.*$/, "");
    const kind = classifyMigrationLine(body);
    if (kind && pushFinding(findings, seen, path, newLine, kind, maxFindings)) {
      return findings;
    }

    newLine++;
  }

  return findings;
}

/** Analyzer entrypoint: added migration SQL lines → risky schema-change findings. No network. */
export async function scanMigrationSafety(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<MigrationSafetyFinding[]> {
  const findings: MigrationSafetyFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || !isMigrationPath(file.path)) continue;
    for (const finding of scanPatchForMigrationSafety(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
