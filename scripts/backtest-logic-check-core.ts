// Pure core for the logic/regex-change backtest CI check (#8139, epic #8082). A PR that rewrites a rule's
// detection logic (not just a threshold, #8138) gets replayed against the rule's real recorded history: the
// classify function feeds each BacktestCase's captured raw context (#8129/#8130, plus #8139's captured model
// response) through a caller-supplied detection function — dynamically imported by the CLI from the PR's own
// head/base checkouts — and the two resulting scores are compared with @loopover/engine's Pareto-floor
// discipline. No IO here — the CLI (backtest-logic-check.ts) does the dynamic imports, corpus read, D1
// persist, and file writes — mirrors scripts/backtest-corpus-export-core.ts's identical pure-core / thin-IO
// split.
import {
  compareBacktestScores,
  renderBacktestComparison,
  scoreBacktest,
  type BacktestCase,
  type BacktestComparison,
} from "@loopover/engine";

// Sibling of THRESHOLD_BACKTEST_EVENT_TYPE in src/services/threshold-backtest-run.ts (#8138's writer) — a
// distinct type so #8140's track-record reads can tell threshold runs and logic runs apart. Deliberately not
// imported from src/ (Worker-bound import graph); same hand-mirrored posture as backtest-track-record.ts.
export const LOGIC_BACKTEST_EVENT_TYPE = "calibration.logic_backtest_run";

// Hand-mirrors RAW_CONTEXT_EXCLUDED_CODES in src/rules/advisory.ts (Worker-bound; not imported — same
// posture as the event-type constant above). `secret_leak` is PERMANENTLY excluded (#8130): no raw context
// is ever captured for it by design, so there is nothing to honestly replay — and a registry entry for it
// would invite storing the very content #8130 exists to keep out of the audit trail.
export const LOGIC_BACKTEST_EXCLUDED_RULE_IDS = new Set<string>(["secret_leak"]);

/** One backtestable detection function: where it lives in a checkout and what export to load. The CLI
 *  imports `exportName` from `<checkoutRoot>/<filePath>` for BOTH the PR's head and base checkouts. */
export type KnownLogicRule = {
  filePath: string;
  exportName: string;
};

// Mirrors #8138's KNOWN_THRESHOLDS registry shape (src/services/threshold-backtest.ts), keyed by ruleId.
// Scoped to exactly `linked_issue_scope_mismatch` (#8139): its corpus carries the richest raw context
// (issueText/prTitle/prBody/diff via #8129, modelResponseText via #8139), and only the DETERMINISTIC
// post-model step — buildLinkedIssueSatisfactionResult's parse/floor/sanitize — is honestly replayable
// (the prompt build and the model call itself are not reproducible from history). Generalizing to the
// other isConfiguredGateBlocker codes #8130 wires is explicit future scope, not this registry's job yet.
export const KNOWN_LOGIC_RULES: Record<string, KnownLogicRule> = {
  linked_issue_scope_mismatch: {
    filePath: "src/services/linked-issue-satisfaction.ts",
    exportName: "buildLinkedIssueSatisfactionResult",
  },
};

/** Resolve a ruleId to its registry entry, failing loud on the permanently excluded `secret_leak` (with the
 *  #8130 rationale, so the error itself explains the boundary) and on any unregistered ruleId. */
export function resolveKnownLogicRule(ruleId: string): KnownLogicRule {
  if (LOGIC_BACKTEST_EXCLUDED_RULE_IDS.has(ruleId)) {
    throw new Error(`rule ${ruleId} is permanently excluded from logic backtesting (#8130): no raw context is ever captured for it`);
  }
  const entry = KNOWN_LOGIC_RULES[ruleId];
  if (!entry) {
    throw new Error(`unknown logic-backtest rule ${ruleId} (known: ${Object.keys(KNOWN_LOGIC_RULES).join(", ")})`);
  }
  return entry;
}

/** The dynamically imported detection function's shape — buildLinkedIssueSatisfactionResult's own signature
 *  (issue text + raw model response in, `{ status }` or null out). A future registry entry must match this
 *  same shape or grow a per-entry adapter — the classify builder below assumes it. */
export type LogicDetectionFn = (issueText: string | null | undefined, modelResponseText: string) => { status: string } | null;

/** Keep only the cases a detection function can honestly be replayed against: both the captured issue text
 *  (#8129) and the captured model response (#8139) must be present and non-empty. Older corpus rows predate
 *  the model-response capture; replaying those would parse empty text and systematically predict "reversed"
 *  for baseline AND candidate — noise, not signal — so they are skipped and reported, never scored. */
export function filterReplayableCases(cases: readonly BacktestCase[]): BacktestCase[] {
  return cases.filter((backtestCase) => {
    const metadata = backtestCase.metadata ?? {};
    return (
      typeof metadata.issueText === "string" &&
      metadata.issueText.trim() !== "" &&
      typeof metadata.modelResponseText === "string" &&
      metadata.modelResponseText.trim() !== ""
    );
  });
}

/**
 * Build a classify function that replays `detect` against a case's captured raw context. The corpus only
 * contains actual firings (an "unaddressed" verdict that carried gate authority — see processors.ts's
 * recordRuleFired site), so a candidate that reproduces the firing (`status === "unaddressed"`) predicts
 * `"confirmed"` (the firing stands); any other outcome — no finding (null), "addressed"/"partial", or a
 * thrown error — means the candidate would NOT have fired, predicting `"reversed"`. Same prediction
 * semantics as buildConfidenceThresholdClassifier (#8138): candidate-would-not-fire ⇒ "reversed". The
 * try/catch mirrors buildLinkedIssueSatisfactionResult's own never-throws fail-safe: a crashing candidate
 * never fires, it does not abort the whole backtest.
 */
export function buildLogicClassifier(detect: LogicDetectionFn): (backtestCase: BacktestCase) => "reversed" | "confirmed" {
  return (backtestCase) => {
    const metadata = backtestCase.metadata ?? {};
    const issueText = typeof metadata.issueText === "string" ? metadata.issueText : "";
    const modelResponseText = typeof metadata.modelResponseText === "string" ? metadata.modelResponseText : "";
    let result: { status: string } | null;
    try {
      result = detect(issueText, modelResponseText);
    } catch {
      result = null;
    }
    return result?.status === "unaddressed" ? "confirmed" : "reversed";
  };
}

/**
 * Backtest a logic/regex change to a single rule's detection function: score the base checkout's version and
 * the head checkout's version as two classifiers over the same replayable corpus (`scoreBacktest`, #8085),
 * then compare them with the Pareto-floor discipline (`compareBacktestScores`, #8086). Mirrors
 * runThresholdBacktest's shape (packages/loopover-engine/src/calibration/backtest-threshold.ts) with detection
 * functions in place of threshold numbers. The excluded-rule guard here is deliberate defense in depth on top
 * of {@link resolveKnownLogicRule} — the scoring path itself refuses `secret_leak`, not just the registry.
 */
export function runLogicBacktest(
  ruleId: string,
  cases: readonly BacktestCase[],
  baselineDetect: LogicDetectionFn,
  candidateDetect: LogicDetectionFn,
): BacktestComparison {
  if (LOGIC_BACKTEST_EXCLUDED_RULE_IDS.has(ruleId)) {
    throw new Error(`rule ${ruleId} is permanently excluded from logic backtesting (#8130)`);
  }
  const baseline = scoreBacktest(ruleId, cases, buildLogicClassifier(baselineDetect));
  const candidate = scoreBacktest(ruleId, cases, buildLogicClassifier(candidateDetect));
  return compareBacktestScores(baseline, candidate);
}

/** First line of the posted comment — the workflow's update step finds an existing comment by this marker so
 *  a re-run edits in place instead of stacking a new comment per push. */
export const LOGIC_BACKTEST_COMMENT_MARKER = "<!-- loopover-logic-backtest -->";

/**
 * Render the standalone advisory PR comment: marker, what was replayed against what, the engine's own
 * comparison Markdown (#8088), and the never-blocks-merge note. Deliberately its OWN comment, not a section
 * of ORB's unified review comment — see #8139's Boundaries (this CI job runs outside the Worker's review
 * flow, and joining that comment would need new Worker↔CI coupling).
 */
export function renderLogicBacktestComment(
  comparison: BacktestComparison,
  info: { replayableCount: number; skippedCount: number; headSha: string; baseSha: string },
): string {
  const skippedNote = info.skippedCount > 0 ? ` ${info.skippedCount} historical case(s) lacked captured raw context and were skipped.` : "";
  return [
    LOGIC_BACKTEST_COMMENT_MARKER,
    "## Logic backtest",
    "",
    `Replayed ${info.replayableCount} historical case(s) for \`${comparison.ruleId}\` through the base` +
      ` (\`${info.baseSha.slice(0, 7)}\`) and head (\`${info.headSha.slice(0, 7)}\`) versions of its detection logic.${skippedNote}`,
    "",
    renderBacktestComparison(comparison),
    "_Advisory only — this check never blocks merge (#8105)._",
    "",
  ].join("\n");
}

/** Single-quoted SQL string literal — mirrors backtest-corpus-export.ts's sqlStringLiteral exactly. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the INSERT persisting one run for #8140's track-record reads — a sibling row to #8138's
 * THRESHOLD_BACKTEST_EVENT_TYPE events, same audit_events columns recordAuditEvent writes (the CLI runs
 * outside the Worker, so it goes through `wrangler d1 execute` instead of the repositories module; the
 * caller supplies id/createdAt so this stays clock-free like the rest of this file). `metadata.comparison`
 * is the field backtest-track-record.ts's reader already looks for.
 */
export function buildLogicBacktestAuditInsertSql(input: {
  id: string;
  targetKey: string;
  comparison: BacktestComparison;
  headSha: string;
  baseSha: string;
  replayableCount: number;
  skippedCount: number;
  createdAt: string;
}): string {
  const metadataJson = JSON.stringify({
    comparison: input.comparison,
    headSha: input.headSha,
    baseSha: input.baseSha,
    replayableCount: input.replayableCount,
    skippedCount: input.skippedCount,
  });
  const values = [
    sqlStringLiteral(input.id),
    sqlStringLiteral(LOGIC_BACKTEST_EVENT_TYPE),
    "'loopover'",
    sqlStringLiteral(input.targetKey),
    // AuditEventRecord.outcome is a fixed enum — "completed" means "this run recorded successfully"; the
    // real verdict lives in detail + metadata.comparison.verdict, mirroring persistThresholdBacktestRuns.
    "'completed'",
    sqlStringLiteral(`logic backtest for ${input.comparison.ruleId}: ${input.comparison.verdict}`),
    sqlStringLiteral(metadataJson),
    sqlStringLiteral(input.createdAt),
  ].join(", ");
  return `INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (${values})`;
}
