// Backoff for a pull request whose verdict never changes (#10184).
//
// metagraphed#8886 was evaluated 56 times on ONE unchanged commit in 47 minutes -- about 1.2 per minute --
// producing the identical `hold | missing_linked_issue` every time. It is CONFLICTING so it cannot merge,
// held so it does not close, and its linked issue was closed by a merged rival (#10168), so the hold never
// clears. It is in a state it cannot leave, and nothing throttled re-entry.
//
// Four such PRs produced 66% of all decision records in a two-hour window. That is not a burst: it is a
// steady drip of legitimately distinct deliveries (CI completions, label writes, sibling activity) arriving
// long after any coalescing window. The webhook coalescer (#10127) collapses SIMULTANEOUS events and cannot
// help here. The missing control is a different kind:
//
//     not "collapse events that arrive together"
//     but "stop asking a question whose answer has not changed"
//
// ── WHAT COUNTS AS "THE SAME ANSWER" ──────────────────────────────────────────────────────────────────────
// The decision fields -- action, reason_code, hold_cause -- and nothing else. Deliberately NOT
// `record_digest`: #8886 has 56 DISTINCT digests for its 56 identical verdicts, because the digest commits to
// per-evaluation data. Using it would make every repeat look novel, which is exactly how this went unnoticed.
//
// ── WHY IT CANNOT STRAND A PR ─────────────────────────────────────────────────────────────────────────────
// The delay is capped, so a stuck PR is still revisited -- just at the sweep's cadence rather than 1.2x/min.
// A new head SHA resets it outright (a new commit is a genuinely new question), and so does any change in the
// verdict itself. Backoff that could grow without bound would trade a spend bug for a liveness bug.

/** The decision fields that make two verdicts "the same answer". Kept as an explicit shape rather than a
 *  free-form string so a caller cannot accidentally fingerprint on something incidental. */
export type VerdictFacts = {
  action: string;
  reasonCode: string;
  /** #9991's recorded hold cause. Null/absent for a verdict that is not a hold. */
  holdCause?: string | null | undefined;
};

/** Stability state carried between evaluations for one (repo, pull, head SHA). */
export type VerdictStabilityState = {
  fingerprint: string;
  /** How many CONSECUTIVE evaluations produced this same fingerprint, including the first. */
  repeats: number;
  /** When the most recent evaluation ran. */
  lastEvaluatedMs: number;
};

/** First delay applied once a verdict has repeated enough to be considered stable. */
export const VERDICT_BACKOFF_BASE_MS = 60_000;

/** Ceiling on the delay. Chosen so a stuck PR is still revisited on roughly the sweep's own cadence -- the
 *  point is to stop the 1.2/min drip, not to stop looking. */
export const VERDICT_BACKOFF_CAP_MS = 15 * 60_000;

/** Repeats tolerated before backoff engages at all. Two identical verdicts can be an ordinary race (a webhook
 *  and the sweep landing together); a third means the answer is genuinely settled. Below this the behaviour
 *  is byte-identical to having no backoff. */
export const VERDICT_BACKOFF_MIN_REPEATS = 3;

/** PURE. The fingerprint two evaluations must share to count as the same answer. */
export function verdictFingerprint(facts: VerdictFacts): string {
  return [facts.action, facts.reasonCode, facts.holdCause ?? ""].join("|");
}

/**
 * PURE. How long to wait before re-evaluating, given how many times this answer has repeated.
 *
 * Exponential from the base, capped. Returns 0 below the threshold so the common case -- a PR whose verdict
 * is still moving -- is completely unaffected.
 */
export function verdictBackoffDelayMs(repeats: number): number {
  if (repeats < VERDICT_BACKOFF_MIN_REPEATS) return 0;
  const doublings = repeats - VERDICT_BACKOFF_MIN_REPEATS;
  // No clamp on the exponent: an earlier version had one, and mutation testing showed removing it changed
  // nothing, because `2 ** 1000` is Infinity and `Math.min(Infinity, cap)` is the cap. The cap is the single
  // thing keeping this bounded, and it is directly tested -- a second guard that no test can distinguish is
  // not defence in depth, it is a claim nobody is checking.
  return Math.min(VERDICT_BACKOFF_BASE_MS * 2 ** doublings, VERDICT_BACKOFF_CAP_MS);
}

/**
 * PURE. Fold a fresh verdict into the prior state.
 *
 * A DIFFERENT fingerprint resets the count to 1 -- the answer moved, so whatever we had learned about its
 * stability is void. Callers reset on a new head SHA by keying the state on the head SHA, so a new commit
 * never sees the old state at all.
 */
export function recordVerdict(prior: VerdictStabilityState | null, facts: VerdictFacts, nowMs: number): VerdictStabilityState {
  const fingerprint = verdictFingerprint(facts);
  const repeats = prior !== null && prior.fingerprint === fingerprint ? prior.repeats + 1 : 1;
  return { fingerprint, repeats, lastEvaluatedMs: nowMs };
}

/**
 * PURE. Should this evaluation be skipped because the answer is settled and the backoff has not elapsed?
 *
 * Fails OPEN in every uncertain case -- no prior state, an unreadable state, or a delay of zero all evaluate
 * normally. A backoff that engaged on missing information would silently stop reviewing PRs, which is far
 * worse than the churn it is trying to prevent.
 */
export function shouldSkipStableVerdict(prior: VerdictStabilityState | null, nowMs: number): boolean {
  if (prior === null) return false;
  // HOLDS ONLY. "Same verdict" is not the same as "nothing happened": a pass can take real actions --
  // update-branch, cap accounting, assignment -- and still produce an unchanged verdict, and throttling that
  // suppresses actual progress. The force-fresh-rebase test (#9497/#2552) is exactly this shape: three
  // identical passes deliberately spend the 24h update-branch cap, and an earlier version of this backoff
  // silently swallowed the third.
  //
  // A `hold` is the one action that means "the gate declined to act", so repeating it genuinely produces
  // nothing -- and it is the case this exists for (#8886: 56 identical holds on one commit). Everything else
  // keeps its current behaviour exactly.
  if (!prior.fingerprint.startsWith("hold|")) return false;
  const delay = verdictBackoffDelayMs(prior.repeats);
  if (delay <= 0) return false;
  return nowMs - prior.lastEvaluatedMs < delay;
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────────────────────────────────
// Same transient-cache idiom as ciPendingDeferStuck (processors.ts): keyed on repo#pr:headSha, so a NEW
// COMMIT never sees the old state -- the reset on a new head is structural rather than a rule someone has to
// remember. Best effort throughout: a cache miss or error yields null, which fails OPEN at every caller.

/** Cache key. Includes the head SHA so a new commit starts clean. */
export function verdictStabilityKey(repoFullName: string, prNumber: number, headSha: string): string {
  return `verdict-stability:${repoFullName.toLowerCase()}#${prNumber}:${headSha}`;
}

/** How long a stability record outlives its last write. Comfortably longer than the cap so a slow-drip PR
 *  keeps accumulating repeats, short enough that an abandoned head SHA does not linger. */
const VERDICT_STABILITY_TTL_SECONDS = 6 * 3600;

type TransientCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

/** Read prior stability state. Null on absence, malformed JSON, or any error -- every one of which must let
 *  the evaluation proceed rather than suppress it. */
export async function readVerdictStability(cache: TransientCache | undefined, key: string): Promise<VerdictStabilityState | null> {
  if (!cache) return null;
  try {
    const raw = await cache.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VerdictStabilityState>;
    if (typeof parsed.fingerprint !== "string" || typeof parsed.repeats !== "number" || typeof parsed.lastEvaluatedMs !== "number") return null;
    if (!Number.isFinite(parsed.repeats) || !Number.isFinite(parsed.lastEvaluatedMs)) return null;
    return { fingerprint: parsed.fingerprint, repeats: parsed.repeats, lastEvaluatedMs: parsed.lastEvaluatedMs };
  } catch {
    return null;
  }
}

/** Persist stability state. Best effort: a failed write means the next evaluation sees no prior state and
 *  proceeds normally, which is the safe direction. */
export async function writeVerdictStability(cache: TransientCache | undefined, key: string, state: VerdictStabilityState): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(key, JSON.stringify(state), VERDICT_STABILITY_TTL_SECONDS);
  } catch {
    // Telemetry-grade write; never fail the pass carrying it.
  }
}
