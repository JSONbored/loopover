// Decision-audit sampling (#8830, epic #8828 Phase 2) — the human-label pipeline.
//
// WHY: the gate's only confirmation signal today is "no human reversed it", which is a lower bound on error,
// not a label — humans reverse only what they notice, so a silently-wrong merge scores as correct. This
// module draws a weekly STRATIFIED sample of decided PRs for human adjudication against a frozen rubric:
// merges oversampled (the costly arm), plus a first-time-author stratum (new contributors are where the
// gate's priors are weakest). Adjudications land in decision_audit_labels (migration 0178) and feed two
// consumers: the calibration set for the risk-control thresholds (#8835) and an audited-accuracy estimate
// whose divergence from the reversal-based number IS the measurement of label bias.
//
// Flag-gated by LOOPOVER_DECISION_AUDIT (default OFF — the weekly job is never enqueued, zero new work,
// byte-identical to today), mirroring every sibling cron flag (selftune-wire et al).
import { LOOPOVER_NATIVE_SOURCE } from "./parity-wire";
import { errorMessage, nowIso } from "../utils/json";

/** Bump ONLY with a corresponding edit to docs/decision-audit-rubric.md — adjudications are comparable only
 *  within a rubric version, and a silent rubric drift would corrupt every downstream estimate. */
export const DECISION_AUDIT_RUBRIC_VERSION = "1";

/** Weekly sample size. ~30/week ≈ 120/month human labels: enough to run the audited-accuracy estimator and
 *  grow #8835's calibration set without making adjudication a burden. */
export const DECISION_AUDIT_SAMPLE_SIZE = 30;

/** Stratum quotas over the sample size: merges oversampled (a wrong merge is the costly error), a dedicated
 *  first-time-author slice (weakest priors), remainder to closes. Shortfalls in any stratum spill into the
 *  others rather than shrinking the week's sample. */
export const DECISION_AUDIT_STRATA = { merge_arm: 0.5, close_arm: 0.3, first_time_author: 0.2 } as const;

export type AuditStratum = keyof typeof DECISION_AUDIT_STRATA;

export function isDecisionAuditEnabled(env: { LOOPOVER_DECISION_AUDIT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_DECISION_AUDIT ?? "").trim());
}

/** One decided PR eligible for sampling. */
export type AuditCandidate = {
  targetId: string; // owner/repo#N
  project: string;
  verdict: "merge" | "close";
  outcome: "merged" | "closed";
  /** True when this PR's author had no earlier decided PR in the ledger at sample time. */
  firstTimeAuthor: boolean;
};

export type PlannedAuditRow = {
  targetId: string;
  project: string;
  verdict: "merge" | "close";
  outcome: "merged" | "closed";
  stratum: AuditStratum;
};

/**
 * PURE stratified sampler. Deterministic under the injected `rng` (tests pass a seeded generator).
 *
 * Selection: first-time-author candidates fill their stratum first (they are the scarcest and also belong
 * to an arm stratum — claiming them first prevents the arm quotas from consuming them all); then each arm
 * fills its quota from the remaining pool; any shortfall spills into a final fill from whatever remains,
 * tagged with the candidate's arm stratum. Never returns more than `k` rows or duplicates a target.
 */
export function planAuditSample(candidates: AuditCandidate[], k: number = DECISION_AUDIT_SAMPLE_SIZE, rng: () => number = Math.random): PlannedAuditRow[] {
  if (k <= 0 || candidates.length === 0) return [];
  const shuffled = [...candidates];
  // Fisher-Yates with the injected rng — the ONLY nondeterminism in the plan.
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const quota = (share: number): number => Math.round(k * share);
  const picked = new Map<string, PlannedAuditRow>();
  const take = (pool: AuditCandidate[], n: number, stratum: AuditStratum | null): void => {
    for (const candidate of pool) {
      if (picked.size >= k || n <= 0) return;
      if (picked.has(candidate.targetId)) continue;
      picked.set(candidate.targetId, {
        targetId: candidate.targetId,
        project: candidate.project,
        verdict: candidate.verdict,
        outcome: candidate.outcome,
        stratum: stratum ?? (candidate.verdict === "merge" ? "merge_arm" : "close_arm"),
      });
      n -= 1;
    }
  };

  take(shuffled.filter((c) => c.firstTimeAuthor), quota(DECISION_AUDIT_STRATA.first_time_author), "first_time_author");
  take(shuffled.filter((c) => c.verdict === "merge"), quota(DECISION_AUDIT_STRATA.merge_arm), "merge_arm");
  take(shuffled.filter((c) => c.verdict === "close"), quota(DECISION_AUDIT_STRATA.close_arm), "close_arm");
  // Spill: fill any remaining budget from the whole pool so a thin stratum never shrinks the week's sample.
  take(shuffled, k - picked.size, null);
  return [...picked.values()];
}

/** Candidate window: the trailing week of decided PRs (the job runs weekly; a longer window would re-offer
 *  PRs already declined by the UNIQUE(target_id) guard for no benefit). */
const CANDIDATE_WINDOW_MS = 7 * 86_400_000;

/**
 * IO: draw this week's sample from the live ledger and insert PENDING rows. Idempotent two ways: re-running
 * within a week re-draws but the UNIQUE(target_id) INSERT OR IGNORE never duplicates a PR, and previously
 * adjudicated PRs are excluded at the candidate query. Best-effort per row — one bad insert never voids the
 * batch. Returns the number of rows actually inserted.
 */
export async function runDecisionAuditSample(env: Env, nowMs: number = Date.now(), rng: () => number = Math.random): Promise<number> {
  const sinceIso = new Date(nowMs - CANDIDATE_WINDOW_MS).toISOString();
  // Decided = latest native gate_decision joined to a realized pr_outcome, inside the window, minus policy
  // actions (enforcement is not a quality decision — #8827) and minus already-sampled targets.
  const { results } = await env.DB.prepare(
    `WITH gd AS (
       SELECT target_id, project, decision AS verdict, summary, created_at,
              ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
         FROM review_audit
        WHERE event_type = 'gate_decision' AND decision IN ('merge', 'close') AND source = ?
     ),
     po AS (
       SELECT target_id, decision AS outcome,
              ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
         FROM review_audit
        WHERE event_type = 'pr_outcome' AND decision IN ('merged', 'closed')
     )
     SELECT gd.target_id AS targetId, gd.project AS project, gd.verdict AS verdict, po.outcome AS outcome
       FROM gd
       JOIN po ON po.target_id = gd.target_id AND po.rn = 1
      WHERE gd.rn = 1
        AND gd.created_at >= ?
        AND (gd.summary IS NULL OR gd.summary NOT LIKE 'policy_close:%')
        AND NOT EXISTS (SELECT 1 FROM decision_audit_labels dal WHERE dal.target_id = gd.target_id)`,
  )
    .bind(LOOPOVER_NATIVE_SOURCE, sinceIso)
    .all<{ targetId: string; project: string; verdict: "merge" | "close"; outcome: "merged" | "closed" }>();

  const decided = results;
  if (decided.length === 0) return 0;

  // First-time detection: the author's earliest decided PR. review_audit carries no logins by design, so the
  // author comes from the pull_requests cache; a PR with no cached row degrades to "not first-time" (the
  // stratum under-fills and the spill covers it) rather than guessing.
  const authorRows = await env.DB.prepare(
    `SELECT repo_full_name || '#' || number AS targetId, author_login AS author FROM pull_requests WHERE author_login IS NOT NULL`,
  ).all<{ targetId: string; author: string }>();
  const authorByTarget = new Map(authorRows.results.map((r) => [r.targetId, r.author.toLowerCase()]));
  const decidedCountByAuthor = new Map<string, number>();
  for (const row of authorRows.results) {
    const author = row.author.toLowerCase();
    decidedCountByAuthor.set(author, (decidedCountByAuthor.get(author) ?? 0) + 1);
  }

  const candidates: AuditCandidate[] = decided.map((row) => {
    const author = authorByTarget.get(row.targetId);
    return {
      targetId: row.targetId,
      project: row.project,
      verdict: row.verdict,
      outcome: row.outcome,
      // author present in authorByTarget implies a count entry (both derive from the same rows), hence the !.
      firstTimeAuthor: author !== undefined && decidedCountByAuthor.get(author)! <= 1,
    };
  });

  const plan = planAuditSample(candidates, DECISION_AUDIT_SAMPLE_SIZE, rng);
  const sampledAt = nowIso();
  let inserted = 0;
  for (const row of plan) {
    try {
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO decision_audit_labels (id, project, target_id, verdict, outcome, stratum, rubric_version, sampled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(`audit:${row.targetId}`.slice(0, 190), row.project.slice(0, 200), row.targetId, row.verdict, row.outcome, row.stratum, DECISION_AUDIT_RUBRIC_VERSION, sampledAt)
        .run();
      if (result.meta.changes > 0) inserted += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "decision_audit_insert_error", target: row.targetId, message: errorMessage(error).slice(0, 160) }));
    }
  }
  return inserted;
}
