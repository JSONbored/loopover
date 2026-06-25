import { listLatestGitHubRateLimitObservations } from "../db/repositories";

// All managed repos share ONE GitHub App installation → ONE hourly REST bucket. To keep heavy maintenance work
// from draining the budget real webhook traffic needs, maintenance yields while there is still headroom:
//   - backfill yields at LOW_REST_RATE_LIMIT_REMAINING;
//   - the re-gate sweep + its per-PR jobs yield EARLIER, at MAINTENANCE_RESERVED_HEADROOM, reserving the budget
//     between the two floors for webhooks. Webhooks never pre-yield — they run, and the queue retries them after
//     the reset if the bucket is exhausted (the surviving event-loss path). (#audit-rate-headroom)
export const LOW_REST_RATE_LIMIT_REMAINING = 75;
export const MAINTENANCE_RESERVED_HEADROOM = 150;

/** The REST rate-limit reset time to wait until when the latest recorded REST budget is at/below `floor`, or
 *  undefined when there is headroom, no usable observation, or the reset is already in the past. Reads the latest
 *  recorded observation (recordGitHubRateLimitObservation writes one per GitHub call) — no live GitHub call. */
export async function shouldWaitForGitHubRateLimit(env: Env, floor: number = LOW_REST_RATE_LIMIT_REMAINING): Promise<string | undefined> {
  const observations = await listLatestGitHubRateLimitObservations(env, 10);
  // Type-guard the find so `remaining` narrows to a number — null/undefined observations are excluded here, so the
  // headroom check below needs no further nullish guard.
  const rest = observations.find((observation): observation is typeof observation & { remaining: number } => observation.resource === "rest" && observation.remaining !== null && observation.remaining !== undefined);
  if (!rest?.resetAt || rest.remaining > floor) return undefined;
  return Date.parse(rest.resetAt) > Date.now() ? rest.resetAt : undefined;
}

/** Seconds to defer a job until a GitHub rate-limit reset, clamped to [30, 900] with a 15s safety margin. An
 *  unparseable reset uses a conservative 60s. */
export function delayUntil(iso: string): number {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return 60;
  return Math.max(30, Math.min(900, Math.ceil(ms / 1000) + 15));
}
