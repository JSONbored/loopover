// Salvageability wire (#8962) — the two cheap decision-time lookups around src/review/salvageability.ts's
// pure score: the author's realized merged history in this repo and this PR's own review-cycle count.
// FAIL-OPEN by contract: any read error returns null, and a null score never changes a disposition — the
// salvageability axis must degrade to today's behavior, never block or unblock the gate on a DB blip.
import { computeSalvageability, type SalvageabilityScore } from "./salvageability";
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckEvaluation } from "../rules/advisory";
import { errorMessage } from "../utils/json";

export async function computeSalvageabilityForTarget(
  env: Env,
  repoFullName: string,
  prNumber: number,
  authorLogin: string | null | undefined,
  gate: Pick<GateCheckEvaluation, "blockers">,
): Promise<SalvageabilityScore | null> {
  const blocker = gate.blockers.find((finding) => AI_JUDGMENT_BLOCKER_CODES.has(finding.code));
  if (!blocker) return null;
  try {
    // Realized MERGED outcomes only (the #8840 lesson: open/cached PRs are not history). Same-repo scoped —
    // salvageability is a statement about this repository's bar, not global reputation.
    const merged = authorLogin
      ? await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM pull_requests p
            WHERE LOWER(p.author_login) = LOWER(?) AND p.repo_full_name = ?
              AND EXISTS (SELECT 1 FROM review_audit ra
                           WHERE ra.event_type = 'pr_outcome' AND ra.decision = 'merged'
                             AND ra.target_id = p.repo_full_name || '#' || p.number)`,
        )
          .bind(authorLogin, repoFullName)
          .first<{ n: number }>()
      : null;
    const cycles = await env.DB.prepare(`SELECT COUNT(*) AS n FROM decision_records WHERE repo_full_name = ? AND pull_number = ?`)
      .bind(repoFullName, prNumber)
      .first<{ n: number }>();
    return computeSalvageability({
      findingText: `${blocker.title} ${blocker.detail}`,
      authorPriorMergedCount: merged?.n ?? 0,
      priorReviewCycles: cycles?.n ?? 0,
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: "salvageability_read_error", target: `${repoFullName}#${prNumber}`, message: errorMessage(error).slice(0, 120) }));
    return null;
  }
}
