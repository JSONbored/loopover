// Shared "post one repo's maintainer review recap" runner (#1963). Used by BOTH the scheduled sweep
// (src/queue/processors.ts) and the on-demand internal `/run` route, so attempt markers and delivery share
// exactly one code path. Reuses the generic signal-snapshot table for "last attempted at" markers — no new
// migration, mirroring repo-doc-refresh-runner.ts (#3003).
import { listLatestSignalSnapshotsForTargets, listSignalSnapshots, persistSignalSnapshot } from "../db/repositories";
import { generateAndSendReviewRecap } from "./review-recap";
import { nowIso } from "../utils/json";
import type { ReviewRecap, SignalSnapshotRecord } from "../types";

const REVIEW_RECAP_ATTEMPT_SIGNAL_TYPE = "review-recap-attempt";

export async function getLastReviewRecapAttemptedAt(env: Env, repoFullName: string): Promise<string | null> {
  const snapshots = await listSignalSnapshots(env, REVIEW_RECAP_ATTEMPT_SIGNAL_TYPE, repoFullName);
  return snapshots[0]?.generatedAt ?? null;
}

export async function getLastReviewRecapAttemptedAtBulk(
  env: Env,
  repoFullNames: readonly string[],
): Promise<Map<string, SignalSnapshotRecord>> {
  return listLatestSignalSnapshotsForTargets(env, REVIEW_RECAP_ATTEMPT_SIGNAL_TYPE, repoFullNames);
}

async function recordReviewRecapAttempt(env: Env, repoFullName: string): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: REVIEW_RECAP_ATTEMPT_SIGNAL_TYPE,
    targetKey: repoFullName,
    repoFullName,
    payload: {},
    generatedAt: nowIso(),
  });
}

/** Build + deliver one repo's recap and record that an attempt happened regardless of delivery outcome
 *  (sent, denied, or error — generateAndSendReviewRecap never throws), so the scheduled sweep does not
 *  re-post until cadenceDays elapses. Manual `/run` triggers reset the same clock. */
export async function performReviewRecap(
  env: Env,
  repoFullName: string,
  options: { windowDays?: number; nowIso?: string } = {},
): Promise<{ recap: ReviewRecap; delivery: { sent: boolean; reason?: string } }> {
  const result = await generateAndSendReviewRecap(env, repoFullName, options);
  await recordReviewRecapAttempt(env, repoFullName);
  return result;
}
