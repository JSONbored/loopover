// Pure core for the calibration-corpus backfill (#8157 phase 1, epic #8082). Transforms historical
// review_targets decisions (decision-level AI verdict + confidence, terminal outcome) into the synthesized
// signal.rule_fired / signal.human_override audit rows the live capture writers (#8101) would have produced
// had they existed then — so the shipped threshold backtest (#8138) and trend view (#8113) start from the
// ledger's real history instead of an empty corpus. No IO here — the CLI (backfill-calibration-corpus.ts)
// does the D1 reads/writes — mirrors backtest-corpus-export-core.ts's identical pure-core / thin-IO split.
//
// Integrity rules (#8157's own Requirements, plus the mapping decision ratified on the issue):
//   • Mapping (a): decision-level CLOSE verdicts synthesize firings for `ai_consensus_defect` — ONE rule id
//     (the close-authority consensus code KNOWN_THRESHOLDS maps to DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE),
//     never duplicated across sibling ids, and every synthesized row carries `backfilled: true` +
//     `provenance` so consumers can include/exclude the era explicitly.
//   • Never fabricate: a row without a close verdict, a numeric confidence, or a terminal outcome yields
//     NOTHING (counted, not guessed). modelResponseText is never synthesized.
//   • Idempotent by construction: deterministic ids + INSERT OR IGNORE, so re-runs are no-ops.
export const BACKFILL_PROVENANCE = "review_targets_decision_level";
/** Mapping (a) — see #8157. The single rule id historical close decisions are synthesized under. */
export const BACKFILL_RULE_ID = "ai_consensus_defect";

const FIRED_EVENT_TYPE = `signal.rule_fired:${BACKFILL_RULE_ID}`;
const OVERRIDE_EVENT_TYPE = `signal.human_override:${BACKFILL_RULE_ID}`;

/** The projection of a review_targets row this transform reads. `confidence` is the decision-level value
 *  json-extracted by the CLI's query; null when absent from decision_json. */
export type ReviewTargetDecisionRow = {
  repo: string;
  number: number;
  verdict: string | null;
  status: string | null;
  confidence: number | null;
  terminalAt: string | null;
};

export type SynthesizedAuditRow = {
  id: string;
  eventType: string;
  actor: string;
  targetKey: string;
  outcome: string;
  detail: string;
  metadataJson: string;
  createdAt: string;
};

export type BackfillReport = {
  eligible: number;
  reversed: number;
  confirmed: number;
  skippedWrongVerdict: number;
  skippedNoConfidence: number;
  skippedNotTerminal: number;
  skippedDuplicateTarget: number;
  rows: SynthesizedAuditRow[];
};

/** SQLite "YYYY-MM-DD HH:MM:SS" (no zone) normalized to ISO-8601 UTC; already-ISO strings pass through.
 *  Returns null for a blank value so eligibility can fail closed on it. */
function normalizeLedgerTimestamp(value: string | null): string | null {
  if (!value || !value.trim()) return null;
  const t = value.includes("T") ? value : value.replace(" ", "T");
  const hasZone = t.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(t);
  const ms = Date.parse(hasZone ? t : `${t}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Synthesize the backfill's fired + override audit rows from historical decisions. Eligibility (all
 * required, each miss counted separately, priority in the listed order): verdict `close`, a numeric
 * decision-level confidence, a parseable terminal timestamp, and a terminal `closed`/`merged` status.
 * Label: `closed` (the close stood) ⇒ `confirmed`; `merged` (a closed-verdict PR that ended MERGED — the
 * decision was wrong) ⇒ `reversed`. One synthesized pair per targetKey (a re-reviewed target keeps its
 * LATEST terminal decision; earlier ones count as duplicates). The override's createdAt sits 1s after the
 * firing's so buildBacktestCorpus's strictly-after pairing always matches. Deterministic output for
 * deterministic input — ids derive from the targetKey alone.
 */
export function synthesizeBackfillRows(rows: readonly ReviewTargetDecisionRow[]): BackfillReport {
  const report: BackfillReport = {
    eligible: 0,
    reversed: 0,
    confirmed: 0,
    skippedWrongVerdict: 0,
    skippedNoConfidence: 0,
    skippedNotTerminal: 0,
    skippedDuplicateTarget: 0,
    rows: [],
  };

  // Latest terminal decision wins per target — sort desc by normalized terminal time, first seen kept.
  const eligible: Array<{ row: ReviewTargetDecisionRow; terminalIso: string }> = [];
  for (const row of rows) {
    if (row.verdict !== "close") {
      report.skippedWrongVerdict += 1;
      continue;
    }
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) {
      report.skippedNoConfidence += 1;
      continue;
    }
    const terminalIso = normalizeLedgerTimestamp(row.terminalAt);
    if (!terminalIso || (row.status !== "closed" && row.status !== "merged")) {
      report.skippedNotTerminal += 1;
      continue;
    }
    eligible.push({ row, terminalIso });
  }
  eligible.sort((a, b) => (a.terminalIso < b.terminalIso ? 1 : a.terminalIso > b.terminalIso ? -1 : 0));

  const seen = new Set<string>();
  for (const { row, terminalIso } of eligible) {
    const targetKey = `${row.repo}#${row.number}`;
    if (seen.has(targetKey)) {
      report.skippedDuplicateTarget += 1;
      continue;
    }
    seen.add(targetKey);
    const label = row.status === "merged" ? "reversed" : "confirmed";
    report.eligible += 1;
    if (label === "reversed") report.reversed += 1;
    else report.confirmed += 1;

    const overrideIso = new Date(Date.parse(terminalIso) + 1000).toISOString();
    report.rows.push(
      {
        id: `backfill:${BACKFILL_RULE_ID}:${targetKey}:fired`,
        eventType: FIRED_EVENT_TYPE,
        actor: "loopover",
        targetKey,
        outcome: "completed",
        detail: `rule ${BACKFILL_RULE_ID} fired (close) against ${targetKey} [backfilled]`,
        metadataJson: JSON.stringify({ outcome: "close", confidence: row.confidence, backfilled: true, provenance: BACKFILL_PROVENANCE }),
        createdAt: terminalIso,
      },
      {
        id: `backfill:${BACKFILL_RULE_ID}:${targetKey}:override`,
        eventType: OVERRIDE_EVENT_TYPE,
        actor: "human",
        targetKey,
        outcome: "completed",
        detail: `human ${label} rule ${BACKFILL_RULE_ID} against ${targetKey} [backfilled]`,
        metadataJson: JSON.stringify({ verdict: label, backfilled: true, provenance: BACKFILL_PROVENANCE }),
        createdAt: overrideIso,
      },
    );
  }
  return report;
}

/** Single-quoted SQL string literal — mirrors backtest-corpus-export.ts's sqlStringLiteral exactly. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the synthesized rows as chunked UPSERT statements. Idempotency comes from the deterministic
 * targetKey-derived ids; `ON CONFLICT(id) DO UPDATE` (rather than OR IGNORE) makes the semantics "latest
 * decision wins" ACROSS runs too, matching the transform's own latest-terminal-wins dedupe: a target whose
 * terminal decision changed between two backfill runs gets its pair UPDATED, never silently dropped
 * (ORB-review finding on the original OR IGNORE shape), while a re-run over identical data remains an
 * effective no-op. Chunked so a statement never grows past what `wrangler d1 execute --command` sanely
 * carries. Returns [] for an empty report.
 */
export function buildBackfillInsertStatements(rows: readonly SynthesizedAuditRow[], chunkSize = 50): string[] {
  const statements: string[] = [];
  for (let start = 0; start < rows.length; start += Math.max(1, chunkSize)) {
    const chunk = rows.slice(start, start + Math.max(1, chunkSize));
    const values = chunk
      .map(
        (row) =>
          `(${[row.id, row.eventType, row.actor, row.targetKey, row.outcome, row.detail, row.metadataJson, row.createdAt]
            .map(sqlStringLiteral)
            .join(", ")})`,
      )
      .join(", ");
    statements.push(
      `INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES ${values} ` +
        `ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, metadata_json = excluded.metadata_json, created_at = excluded.created_at`,
    );
  }
  return statements;
}

/** The human-readable dry-run/apply summary the CLI prints and #8157's report requires. Pure string build. */
export function renderBackfillReport(report: BackfillReport, mode: "dry-run" | "apply"): string {
  return [
    `Calibration corpus backfill (${mode}) — mapping (a), rule ${BACKFILL_RULE_ID}, provenance ${BACKFILL_PROVENANCE}`,
    `  eligible decisions: ${report.eligible} (confirmed ${report.confirmed}, reversed ${report.reversed})`,
    `  synthesized audit rows: ${report.rows.length} (fired + override pairs)`,
    `  skipped: wrong-verdict ${report.skippedWrongVerdict}, no-confidence ${report.skippedNoConfidence}, not-terminal ${report.skippedNotTerminal}, duplicate-target ${report.skippedDuplicateTarget}`,
  ].join("\n");
}
