// Scheduled checkpoint anchoring (#9274, epic #9267). Ties #9272 (Rekor) and #9273 (git-commit) together into
// a periodic job -- checkpoint cadence, not per-record, per the mechanism research on #9267: anchoring every
// decision record is wrong on every axis (Rekor is a donated public good; a git commit per PR review is
// noise; a naive per-record job has no natural batching anyway).
import { errorMessage, nowIso } from "../utils/json";
import { buildLedgerAnchorPayload, currentAnchorKey, parseAnchorPublicKeys, signLedgerAnchorPayload, type SignedLedgerAnchor } from "./ledger-anchor";
import { loadDecisionLedgerTip } from "./decision-record";
import { anchorBackendsMissingForRowHash, loadLastLedgerAnchorAttempt, recordLedgerAnchorAttempt, type LedgerAnchorBackend } from "./ledger-anchor-persistence";
import { submitToRekor } from "./ledger-anchor-rekor";
import type { LedgerAnchorGitTarget } from "./ledger-anchor-git";

/** Bounds the unanchored window by record count, independent of the hourly clock -- a burst of activity
 *  cannot sit unanchored for a full hour just because it happened between ticks. */
export const LEDGER_ANCHOR_SEQ_THRESHOLD = 256;

export type LedgerAnchorScheduleDecision =
  | { shouldAnchor: false; reason: "empty_ledger" | "unchanged" }
  | { shouldAnchor: true; reason: "hourly" | "seq_threshold" | "retry_unanchored" };

/**
 * Pure scheduling decision: given the live tip and the last attempt (regardless of that attempt's own
 * success/failure -- see {@link loadLastLedgerAnchorAttempt}'s own reasoning), should THIS tick anchor?
 *
 * `seq_threshold` is checked treating a never-anchored ledger as starting from seq 0 -- a burst of >= the
 * threshold worth of activity before the very first anchor ever still fires immediately, rather than waiting
 * for the next hourly tick just because there is no prior anchor to compare against.
 */
export function decideLedgerAnchorSchedule(input: {
  isHourly: boolean;
  currentTip: { seq: number; rowHash: string };
  lastAnchor: { seq: number; rowHash: string } | null;
  seqThreshold: number;
  /** #9489: backends with NO successful anchor for the current tip's rowHash. Non-empty means the tip is
   *  unanchored on at least one backend even though nothing has moved, so an hourly tick should retry. */
  unanchoredBackends?: readonly string[] | undefined;
}): LedgerAnchorScheduleDecision {
  if (input.currentTip.seq === 0) return { shouldAnchor: false, reason: "empty_ledger" };

  const lastAnchorSeq = input.lastAnchor?.seq ?? 0;
  if (input.currentTip.seq - lastAnchorSeq >= input.seqThreshold) return { shouldAnchor: true, reason: "seq_threshold" };

  const tipUnchanged = input.lastAnchor !== null && input.lastAnchor.rowHash === input.currentTip.rowHash;
  if (input.isHourly && !tipUnchanged) return { shouldAnchor: true, reason: "hourly" };
  // #9489: an unchanged tip is only "nothing to do" if it is actually ANCHORED. The previous check compared
  // against the newest ATTEMPT regardless of status, so a failure at a quiet tip was never retried -- Rekor
  // 429s at seq N, the ledger goes quiet, and every later tick reports "unchanged" while the tip carries no
  // valid external anchor at all. Retrying on the hourly tick gives it a bounded, self-healing cadence.
  if (input.isHourly && tipUnchanged && input.unanchoredBackends && input.unanchoredBackends.length > 0) {
    return { shouldAnchor: true, reason: "retry_unanchored" };
  }

  return { shouldAnchor: false, reason: "unchanged" };
}

/** Reads the four `LOOPOVER_LEDGER_ANCHOR_GIT_*` config vars into a target, or `null` when the required
 *  owner/repo pair is unset -- git anchoring is simply not configured yet, the same honest-degrade posture
 *  as an unset signing key, not an error. */
export function resolveGitAnchorTarget(env: {
  LOOPOVER_LEDGER_ANCHOR_GIT_OWNER?: string;
  LOOPOVER_LEDGER_ANCHOR_GIT_REPO?: string;
  LOOPOVER_LEDGER_ANCHOR_GIT_BRANCH?: string;
  LOOPOVER_LEDGER_ANCHOR_GIT_PATH?: string;
}): LedgerAnchorGitTarget | null {
  const owner = env.LOOPOVER_LEDGER_ANCHOR_GIT_OWNER;
  const repo = env.LOOPOVER_LEDGER_ANCHOR_GIT_REPO;
  if (!owner || !repo) return null;
  return { owner, repo, branch: env.LOOPOVER_LEDGER_ANCHOR_GIT_BRANCH || "main", path: env.LOOPOVER_LEDGER_ANCHOR_GIT_PATH || "anchors.jsonl" };
}

export type LedgerAnchorSchedulerDeps = {
  /** Defaults to the real Rekor backend. Injectable so a test exercises the scheduler's own decision logic
   *  without a real network call. */
  submitRekor?: (signed: SignedLedgerAnchor, publicKeySpki: string) => Promise<void>;
  /** `null`/omitted when git anchoring isn't configured (no target, no installation) -- the scheduler simply
   *  skips that backend, same posture as an unset signing key. The real caller (the queue processor) wraps
   *  the actual `submitToGitAnchor` call in `withInstallationTokenRetry` here, so a stale token retries the
   *  WHOLE attempt with a fresh one, matching every other GitHub write in this engine. */
  submitGit?: ((signed: SignedLedgerAnchor) => Promise<void>) | null;
};

/**
 * Run one scheduling tick. Never blocks a review: this has no caller in the live decision-record persist
 * path at all -- it exists only as a queued background job (#9274's own dispatch wiring) -- and neither
 * backend it calls ever rejects (each records its own `status: 'failed'` via #9271 instead of throwing), so
 * a total anchoring failure cannot propagate anywhere. Returns the scheduling decision so a caller/test can
 * observe WHY nothing happened, without needing a second query.
 */
/** #9489/#9646: the backends whose success actually matters for "is this tip anchored" — computed from the
 *  backends this tick will ACTUALLY attempt, not a fixed constant. `rekor` always; `git` only when a git
 *  submitter is configured (deps.submitGit non-null), so an unconfigured git backend cannot leave a
 *  fully-rekor-anchored quiet tip permanently "missing git" and re-anchoring every hourly tick. `ots` is
 *  tracked-but-not-built (#9267), so requiring it would make every tip permanently unanchored. */
function requiredSuccessBackends(deps: LedgerAnchorSchedulerDeps): LedgerAnchorBackend[] {
  return deps.submitGit ? ["rekor", "git"] : ["rekor"];
}

export async function runScheduledLedgerAnchor(env: Env, options: { isHourly: boolean; now?: string }, deps: LedgerAnchorSchedulerDeps = {}): Promise<LedgerAnchorScheduleDecision> {
  const now = options.now ?? nowIso();
  const [tip, lastAnchor] = await Promise.all([loadDecisionLedgerTip(env), loadLastLedgerAnchorAttempt(env)]);
  // #9489: which backends still have NO successful anchor for this exact tip. An unchanged tip is only
  // "nothing to do" when it is genuinely anchored -- otherwise a failure at a quiet tip is never retried, and
  // a success on one backend masks a failure on the other, since the newest-attempt row wins regardless of
  // which backend wrote it.
  /* v8 ignore next -- fail-open: an unreadable anchors table degrades to "nothing known to be missing", i.e.
     exactly the pre-#9489 scheduling behaviour, rather than forcing an anchor on every tick. */
  const unanchoredBackends = await anchorBackendsMissingForRowHash(env, tip.rowHash, requiredSuccessBackends(deps)).catch(() => []);
  const decision = decideLedgerAnchorSchedule({
    isHourly: options.isHourly,
    currentTip: tip,
    lastAnchor,
    seqThreshold: LEDGER_ANCHOR_SEQ_THRESHOLD,
    unanchoredBackends,
  });
  if (!decision.shouldAnchor) return decision;

  const keys = parseAnchorPublicKeys(env.LOOPOVER_LEDGER_ANCHOR_KEYS);
  const current = currentAnchorKey(keys);
  if (!current || !env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY) {
    console.log(
      JSON.stringify({
        event: "ledger_anchor_skipped_unconfigured",
        reason: !current ? "no_current_signing_key_published" : "no_private_key_configured",
      }),
    );
    return decision;
  }

  const payload = buildLedgerAnchorPayload(tip, now);
  const signed = await signLedgerAnchorPayload(payload, env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY, current.keyId);

  const submitRekor = deps.submitRekor ?? ((s, publicKeySpki) => submitToRekor(env, s, publicKeySpki, fetch));
  // guardedSubmit is the actual safety boundary, not a convention every injected function is trusted to
  // honor: #9272's real submitToRekor and #9273's real submitToGitAnchor never reject on their own, but an
  // INJECTED submitGit (the real caller wraps token-minting around submitToGitAnchor, and minting a fresh
  // installation token is a genuine IO call that CAN throw, unlike anything inside submitToGitAnchor itself)
  // is not something this module controls. Catching here, once, centrally, is what makes "neither backend
  // ever rejects" true structurally rather than by every call site's own discipline.
  const guardedSubmit = async (backend: LedgerAnchorBackend, submit: () => Promise<void>): Promise<void> => {
    try {
      await submit();
    } catch (error) {
      await recordLedgerAnchorAttempt(env, { payload: signed.payload, signature: signed.signature, keyId: signed.keyId, backend, status: "failed", error: errorMessage(error) });
    }
  };

  const attempts: Promise<void>[] = [guardedSubmit("rekor", () => submitRekor(signed, current.publicKeySpki))];
  if (deps.submitGit) {
    const submitGit = deps.submitGit;
    attempts.push(guardedSubmit("git", () => submitGit(signed)));
  }
  await Promise.all(attempts);

  return decision;
}
