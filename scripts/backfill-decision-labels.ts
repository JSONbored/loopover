#!/usr/bin/env node
// Backfill the risk-control calibration set (#8828 follow-through) — thin IO around
// backfill-decision-labels-core.ts. Reads candidate rows as JSON on stdin, emits a staging bundle on
// stdout. Deliberately infrastructure-free: the operator owns extraction and application.
//
// EXTRACT (run against the instance's Postgres; produces the stdin payload):
//   SELECT json_agg(t) FROM (
//     SELECT ra.target_id      AS "targetId",
//            split_part(ra.target_id, '#', 1) AS "project",
//            c.pull_number     AS "pullNumber",
//            ra.decision       AS "decision",
//            ra.head_sha       AS "headSha",
//            ra.created_at     AS "decidedAt",
//            c.findings_json   AS "findingsJson",
//            go.blocker_codes_json AS "blockerCodesJson",
//            (SELECT ra2.decision FROM review_audit ra2
//              WHERE ra2.event_type = 'pr_outcome' AND ra2.target_id = ra.target_id
//              ORDER BY ra2.created_at DESC LIMIT 1) AS "realizedOutcome"
//              -- the LAST pr_outcome is the definitive story: merged after a close = reopened + merged
//       FROM review_audit ra
//       JOIN LATERAL (
//              SELECT * FROM ai_review_cache c
//               WHERE c.repo_full_name || '#' || c.pull_number = ra.target_id
//                 AND c.findings_json LIKE '%confidence%'
//               ORDER BY (c.head_sha = ra.head_sha) DESC, c.created_at DESC LIMIT 1
//            ) c ON true
//       LEFT JOIN gate_outcomes go
//              ON go.repo_full_name || '#' || go.pull_number = ra.target_id AND go.head_sha = ra.head_sha
//      WHERE ra.event_type = 'gate_decision' AND ra.decision IN ('close', 'hold')
//        AND ra.created_at >= '2026-06-28'
//   ) t;
//
// STAGE:
//   node --experimental-strip-types scripts/backfill-decision-labels.ts < candidates.json > bundle.json
//
// APPLY (after adjudication sign-off; both idempotent via ON CONFLICT DO NOTHING). CLOSE_ARM LABELS ONLY —
// holdout_close rows are analysis output, not calibration rows (see the core header's population note):
//   \set records `jq -c .records bundle.json`
//   INSERT INTO decision_records SELECT * FROM jsonb_populate_recordset(NULL::decision_records, :'records'::jsonb)
//   ON CONFLICT (id) DO NOTHING;
//   -- likewise .labels -> decision_audit_labels (staged status='pending'; adjudications are a later UPDATE)
//
// Backfilled records carry configDigest "backfill:unavailable" — the historical resolved config is
// unknowable and a fabricated sha256 would corrupt the commitment semantics; the sentinel is also the
// record's provenance marker. They are NOT appended to the decision ledger: the ledger attests decisions
// as they were finalized live, and reconstructed history has no place in that chain.
import { planDecisionLabelBackfill, type CandidateRow } from "./backfill-decision-labels-core";
import { buildDecisionRecord, canonicalJson } from "../src/review/decision-record";
import { DECISION_AUDIT_RUBRIC_VERSION } from "../src/review/decision-audit";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildBundle(rows: CandidateRow[], stagedAt: string): Promise<Record<string, unknown>> {
  const plan = planDecisionLabelBackfill(rows);
  const records = [];
  const labels = [];
  const worklist = [];
  for (const target of plan.staged) {
    const { record, recordDigest } = await buildDecisionRecord({
      repoFullName: target.project,
      pullNumber: target.pullNumber,
      headSha: target.headSha,
      action: target.stratum === "close_arm" ? "close" : "hold",
      reasonCode: target.reasonCode,
      configDigest: "backfill:unavailable",
      modelIds: null,
      promptDigest: null,
      aiConfidence: target.aiConfidence,
      decidedAt: target.decidedAt,
    });
    records.push({
      id: `record:${target.targetId}@${target.headSha}`.slice(0, 250),
      repo_full_name: target.project.slice(0, 200),
      pull_number: target.pullNumber,
      head_sha: target.headSha,
      action: record.action,
      reason_code: record.reasonCode.slice(0, 200),
      record_digest: recordDigest,
      record_json: canonicalJson(record),
      created_at: target.decidedAt,
    });
    labels.push({
      id: `audit:${target.targetId}`.slice(0, 190),
      project: target.project.slice(0, 200),
      target_id: target.targetId,
      verdict: target.verdict,
      outcome: target.outcome,
      stratum: target.stratum,
      rubric_version: DECISION_AUDIT_RUBRIC_VERSION,
      sampled_at: stagedAt,
      status: "pending",
      adjudication: null,
      reason_category: null,
      adjudicated_at: null,
    });
    worklist.push({
      targetId: target.targetId,
      stratum: target.stratum,
      confidence: target.aiConfidence,
      reasonCode: target.reasonCode,
      findingTitle: target.findingTitle.slice(0, 300),
      decidedAt: target.decidedAt,
      outcome: target.outcome,
      definitiveAdjudication: target.definitiveAdjudication,
    });
  }
  return { stagedAt, skipped: plan.skipped, records, labels, worklist };
}

const invokedDirectly = process.argv[1]?.endsWith("backfill-decision-labels.ts") === true;
if (invokedDirectly) {
  readStdin()
    .then(async (raw) => {
      const rows = JSON.parse(raw) as CandidateRow[];
      const bundle = await buildBundle(rows, new Date().toISOString());
      process.stdout.write(`${JSON.stringify(bundle, null, 1)}\n`);
      const skipped = bundle.skipped as Record<string, number>;
      console.error(
        `backfill-decision-labels: ${rows.length} candidate(s) -> ${(bundle.records as unknown[]).length} staged; skipped: ${Object.entries(skipped)
          .map(([key, count]) => `${key}=${count}`)
          .join(" ")}`,
      );
    })
    .catch((error: unknown) => {
      console.error(`backfill-decision-labels: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
