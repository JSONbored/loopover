// Verdict-flip persistence (#9016, security) — the IO around src/review/verdict-flip-guard.ts's pure state
// machine. One row per PR (migration 0183); fail-open throughout — an infra blip must degrade to "never
// escalate," never block or unblock the gate on its own.
import { findingsHadAiDefect, nextVerdictFlipState, type VerdictFlipResult, type VerdictFlipState } from "./verdict-flip-guard";
import { errorMessage, nowIso } from "../utils/json";

export async function readVerdictFlipState(env: Env, repoFullName: string, pullNumber: number): Promise<VerdictFlipState | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT last_had_defect AS lastHadDefect, flip_count AS flipCount, last_fingerprint AS lastFingerprint FROM ai_review_verdict_flips WHERE repo_full_name = ? AND pull_number = ?",
    )
      .bind(repoFullName, pullNumber)
      .first<{ lastHadDefect: number; flipCount: number; lastFingerprint: string | null }>();
    if (!row) return null;
    return { lastHadDefect: row.lastHadDefect === 1, flipCount: row.flipCount, lastFingerprint: row.lastFingerprint };
  } catch (error) {
    console.warn(JSON.stringify({ event: "verdict_flip_read_error", repoFullName, pullNumber, message: errorMessage(error).slice(0, 120) }));
    return null;
  }
}

async function writeVerdictFlipState(env: Env, repoFullName: string, pullNumber: number, next: VerdictFlipState): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_review_verdict_flips (repo_full_name, pull_number, last_had_defect, flip_count, last_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_full_name, pull_number) DO UPDATE SET last_had_defect = excluded.last_had_defect, flip_count = excluded.flip_count, last_fingerprint = excluded.last_fingerprint, updated_at = excluded.updated_at`,
    )
      .bind(repoFullName, pullNumber, next.lastHadDefect ? 1 : 0, next.flipCount, next.lastFingerprint ?? null, nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "verdict_flip_write_error", repoFullName, pullNumber, message: errorMessage(error).slice(0, 120) }));
  }
}

/**
 * Record one FRESH AI-review verdict (never call for a cache-hit reuse — see verdict-flip-guard's doc
 * comment) and return the advanced flip state. Fail-open: any read/write error degrades to treating this
 * as a first observation (flipCount 0, never escalates) — an infra blip must never itself force a hold.
 */
export async function recordVerdictFlip(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  findings: ReadonlyArray<{ code: string }>,
  /** #9483: the review's content fingerprint. A flip only counts when it MATCHES the prior verdict's, so
   *  honest iteration on genuinely changed content resets rather than accumulating toward a permanent hold. */
  fingerprint?: string | null | undefined,
): Promise<VerdictFlipResult> {
  const hadDefect = findingsHadAiDefect(findings);
  const prior = await readVerdictFlipState(env, repoFullName, pullNumber);
  const next = nextVerdictFlipState(prior, hadDefect, fingerprint);
  await writeVerdictFlipState(env, repoFullName, pullNumber, next);
  return next;
}
