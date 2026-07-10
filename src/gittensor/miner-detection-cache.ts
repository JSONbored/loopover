// Minimal, cached "is this login a CONFIRMED official Gittensor miner" check (#4512/#4513), shared by call
// sites that need only a boolean identity check -- not the full audit-logged flow processors.ts's
// getCachedOfficialMinerDetection uses for PR-comment command authorization. Same cache table/TTLs, no
// audit-log side effect. Deliberately its own module (not exported from processors.ts) so review/-layer
// code (unlinked-issue-guardrail.ts, reputation-wire.ts) can import it without a circular dependency —
// processors.ts is the one that imports FROM those modules.

import { getFreshOfficialMinerDetection, upsertOfficialMinerDetection } from "../db/repositories";
import { fetchOfficialGittensorMiner } from "./api";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;

/** Fail-safe: any lookup failure resolves to "not a confirmed miner," never the reverse. */
export async function isConfirmedOfficialMiner(env: Env, login: string): Promise<boolean> {
  const cached = await getFreshOfficialMinerDetection(env, login).catch(() => null);
  if (cached) return cached.status === "confirmed";
  // fetchOfficialGittensorMiner already converts every failure into a returned {status: "unavailable"}
  // value rather than rejecting -- nothing to catch here.
  const detection = await fetchOfficialGittensorMiner(login);
  // A cache-write failure must never block the caller from using the freshly-fetched (just uncached)
  // detection -- worst case, the next call re-fetches instead of hitting the cache.
  const cacheable = await upsertOfficialMinerDetection(
    env,
    login,
    detection,
    detection.status === "unavailable" ? OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS : OFFICIAL_MINER_DETECTION_TTL_MS,
  ).catch(() => detection);
  return cacheable.status === "confirmed";
}
