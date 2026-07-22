#!/usr/bin/env node
// Read-only ORB D1 → rule-precision backtest corpus export (#8084, epic #8082). Queries audit_events for one
// rule's `signal.rule_fired:<ruleId>` / `signal.human_override:<ruleId>` rows via `wrangler d1 execute --json`
// (no writes), reconstructs RuleFiredEvent/HumanOverrideEvent the same way signal-tracking-wire.ts does, runs
// buildBacktestCorpus, and writes a checksummed JSON snapshot. The pure transform lives in
// backtest-corpus-export-core.ts (unit-tested); this file is the thin IO wrapper — mirrors export-d1-data.ts.
//
//   tsx scripts/backtest-corpus-export.ts --rule-id <ruleId> --output <file.json> [--remote] [--since-date <iso>] [--db loopover]
//
// --remote reads the deployed D1 (default is the local miniflare DB). --since-date does an INCREMENTAL export
// (rows whose created_at is >= the date); omit it for a full history. NEVER pass a write command. ORB only —
// AMS's event-ledger export is out of scope.
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildBacktestCorpus, type BacktestCase, type HumanOverrideEvent, type RuleFiredEvent } from "@loopover/engine";
import { buildBacktestCorpusManifest } from "./backtest-corpus-export-core.js";

type D1Row = Record<string, unknown>;

type Args = {
  ruleId: string | undefined;
  output: string | undefined;
  remote: boolean;
  sinceDate: string | undefined;
  db: string;
};

const RULE_FIRED_EVENT_TYPE_PREFIX = "signal.rule_fired:";
const HUMAN_OVERRIDE_EVENT_TYPE_PREFIX = "signal.human_override:";

function parseArgs(argv: string[]): Args {
  const args: Args = { ruleId: undefined, output: undefined, remote: false, sinceDate: undefined, db: "loopover" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--rule-id") args.ruleId = argv[++i];
    else if (flag === "--output") args.output = argv[++i];
    else if (flag === "--since-date") args.sinceDate = argv[++i];
    else if (flag === "--db") args.db = argv[++i]!;
  }
  return args;
}

// Run a read-only SQL statement via wrangler and return the result rows. Throws on any wrangler failure so a
// partial/garbled export can never be mistaken for a complete one. Mirrors export-d1-data.ts's d1Query.
function d1Query(db: string, remote: boolean, sql: string): D1Row[] {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout);
  // wrangler returns [{ results: [...], success, meta }] (one entry per statement).
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseMetadataJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* corrupt row -- fail open to {} (mirrors listAuditEventsByType) */
  }
  return {};
}

// Mirrors src/review/signal-tracking-wire.ts's toRuleFiredEvent — keep in sync with that adapter; do not import
// it (private to the live ORB adapter; this CLI is a read-only export path).
function toRuleFiredEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): RuleFiredEvent {
  const outcome = typeof row.metadata.outcome === "string" ? row.metadata.outcome : "";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.outcome;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    outcome,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

// Mirrors src/review/signal-tracking-wire.ts's toHumanOverrideEvent — keep in sync with that adapter.
function toHumanOverrideEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): HumanOverrideEvent {
  const verdict = row.metadata.verdict === "reversed" ? "reversed" : "confirmed";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.verdict;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    verdict,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

function rowCreatedAt(row: D1Row): string {
  return typeof row.created_at === "string" ? row.created_at : "";
}

function rowTargetKey(row: D1Row): string | null {
  return typeof row.target_key === "string" ? row.target_key : null;
}

function rowEventType(row: D1Row): string {
  return typeof row.event_type === "string" ? row.event_type : "";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ruleId || !args.output) {
    console.error(
      "Usage: tsx scripts/backtest-corpus-export.ts --rule-id <ruleId> --output <file.json> [--remote] [--since-date <iso>] [--db loopover]",
    );
    process.exit(2);
  }

  const firedType = `${RULE_FIRED_EVENT_TYPE_PREFIX}${args.ruleId}`;
  const overrideType = `${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX}${args.ruleId}`;
  const sinceClause = args.sinceDate ? ` AND created_at >= ${sqlStringLiteral(args.sinceDate)}` : "";
  const sql =
    `SELECT event_type, target_key, metadata_json, created_at FROM audit_events` +
    ` WHERE (event_type = ${sqlStringLiteral(firedType)} OR event_type = ${sqlStringLiteral(overrideType)})` +
    sinceClause +
    ` ORDER BY created_at ASC`;

  const rows = d1Query(args.db, args.remote, sql);
  const fired: RuleFiredEvent[] = [];
  const overrides: HumanOverrideEvent[] = [];
  for (const row of rows) {
    const projected = {
      targetKey: rowTargetKey(row),
      metadata: parseMetadataJson(row.metadata_json),
      createdAt: rowCreatedAt(row),
    };
    const eventType = rowEventType(row);
    if (eventType === firedType) fired.push(toRuleFiredEvent(args.ruleId, projected));
    else if (eventType === overrideType) overrides.push(toHumanOverrideEvent(args.ruleId, projected));
  }

  const cases: BacktestCase[] = buildBacktestCorpus(args.ruleId, fired, overrides);
  const manifest = buildBacktestCorpusManifest(args.ruleId, cases, {
    generatedAt: new Date().toISOString(),
    source: args.remote ? "d1-remote" : "d1-local",
    database: args.db,
    incremental: Boolean(args.sinceDate),
    ...(args.sinceDate ? { sinceDate: args.sinceDate } : {}),
  });
  writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`exported ${manifest.caseCount} cases for rule ${args.ruleId} (checksum ${manifest.checksum.slice(0, 12)}…) → ${args.output}`);
}

main();
