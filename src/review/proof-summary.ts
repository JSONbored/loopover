// Public proof-page summary (#9569) — the shareable, unauthenticated twin of the in-app trust panel.
//
// ONE IMPLEMENTATION, TWO RENDERINGS. This module is the single composition both surfaces read: the public
// proof page here and the in-app per-repo trust panel (#9193) render the SAME object, so the two can never
// disagree about a figure. A number that appears in one and not the other, or differs between them, would
// undermine the exact property this page exists to demonstrate.
//
// ── THE PRIVACY BOUNDARY IS STRUCTURAL ───────────────────────────────────────────────────────────────
// Every field below is built by NAMING it, never by filtering a wider object. That distinction is the whole
// control: a blocklist has to anticipate every field a future upstream type might grow, and silently leaks
// the one it did not anticipate. An allowlisted shape cannot leak a field nobody wrote down, so wallet,
// hotkey, reward, trust-score and private-ranking data are unreachable here by construction rather than by
// vigilance. `buildProofSummary` takes only already-public inputs and copies named scalars out of them.
//
// ── NEVER A BARE SCALAR ──────────────────────────────────────────────────────────────────────────────
// Any accuracy figure travels with its COVERAGE (how many decisions it is computed over) and a Wilson
// confidence INTERVAL. A "97% accurate" with no denominator is marketing; the same number over 31 decisions
// with a [0.84, 0.99] interval is a claim someone can argue with. Wilson rather than Wald because a gate
// metric lives near p→1, exactly where Wald claims impossible certainty (see `wilsonInterval`'s own note).
// Below the sample floor the accuracy is `null` — no data must render as no claim, never as a fabricated
// zero or a bare percentage.
//
// ── HONEST BOUNDARY STATES ───────────────────────────────────────────────────────────────────────────
// Not-yet-anchored and no-published-records are NEUTRAL states carrying the verification contract's own
// language, not errors and not blanks. A repo that has not been anchored yet is not a failing repo; a page
// that renders that as an error would be lying in the more damaging direction.
import { wilsonInterval } from "../orb/analytics";
import type { PublicLedgerAnchor } from "./ledger-anchor-persistence";

/** The floor below which an accuracy figure is not published at all. Mirrors the public precision block's
 *  own discipline: a percentage over a handful of decisions is noise wearing a number's clothes. */
export const PROOF_MIN_DECISIONS = 20;

/** How many published decision records the page samples. Enough to be checkable by hand, small enough that
 *  the page stays a summary rather than a dump. */
export const PROOF_SAMPLE_RECORDS = 5;

export type ProofLedgerStatus =
  | { state: "verified"; tipSeq: number; totalCount: number; checkedAt: string; prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number }
  /** `brokenKind` travels alongside the position because the KIND of break is the actionable half: a
   *  pruned-preimage short tail and a row-hash mismatch are very different claims about this operator. */
  | { state: "broken"; tipSeq: number; totalCount: number; checkedAt: string; brokenAtSeq: number; brokenKind: string }
  | { state: "empty"; checkedAt: string }
  | { state: "unavailable"; checkedAt: string };

export type ProofAnchorStatus =
  | { state: "anchored"; backend: string; seq: number; rowHash: string; at: string }
  | { state: "not_yet_anchored" };

export type ProofAccuracy =
  | { state: "published"; accuracy: number; decided: number; confirmed: number; interval: { lo: number; hi: number } }
  /** Below the floor. `decided` is still published — "we have 7 decisions, too few to claim a rate" is a
   *  more honest statement than hiding the count along with the figure. */
  | { state: "insufficient_data"; decided: number; minimumDecisions: number };

export type ProofSampleRecord = { pullNumber: number; action: string; reasonCode: string; decidedAt: string; recordDigest: string };

export type ProofSummary = {
  schemaVersion: 1;
  repoFullName: string;
  decisionCount: number;
  accuracy: ProofAccuracy;
  ledger: ProofLedgerStatus;
  anchor: ProofAnchorStatus;
  sampleRecords: ProofSampleRecord[];
  /** The plain-language boundary statement — what this page does NOT prove. Carried IN the payload so a
   *  screenshot or an embed cannot shed it the way a footer caption can. */
  boundary: string;
};

/** The verification contract's own language for the limit of what anchoring proves (#9420's framing). */
export const PROOF_BOUNDARY_STATEMENT =
  "Anchoring bounds how far back an undetected rewrite could reach; it does not make every row checkable in real time. A rewrite made since the last checkpoint, followed by ordinary appends, is absorbed into future anchors.";

/** Round to 3dp — the precision the rest of the public surface publishes at. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Fold decision counts into a publishable accuracy claim, or into an explicit insufficient-data state.
 *
 * PURE. `confirmed`/`decided` come from the already-public precision block; nothing new is computed here
 * and no new SQL surface exists for this page.
 */
export function buildProofAccuracy(decided: number, confirmed: number | null, minimumDecisions: number = PROOF_MIN_DECISIONS): ProofAccuracy {
  // #10012: a null `confirmed` means the reversal read (its own section in loadProofSummary) FAILED. A rate
  // must never be asserted on a failed read -- degrade to insufficient_data rather than treating the missing
  // count as zero (which would publish a fabricated accuracy of 0).
  if (confirmed === null) return { state: "insufficient_data", decided: Math.max(0, decided), minimumDecisions };
  // ONE guard for both reasons a rate is unpublishable, and both arms are reachable: `wilsonInterval`
  // returns null exactly when there are no trials, which IS the "nothing decided" case, so checking it
  // here rather than pre-empting it with a separate `decided <= 0` test avoids a branch no input can take.
  const interval = wilsonInterval(confirmed, decided);
  if (!interval || decided < minimumDecisions) return { state: "insufficient_data", decided: Math.max(0, decided), minimumDecisions };
  return {
    state: "published",
    accuracy: round3(confirmed / decided),
    decided,
    confirmed,
    interval: { lo: round3(interval.lo), hi: round3(interval.hi) },
  };
}

/** Project the newest SUCCESSFUL anchor onto the page's anchor state. A failed attempt is not an anchor:
 *  the public attempt log (#9271) is where failures are legible, and presenting one here as "anchored"
 *  would claim corroboration that does not exist. */
export function buildProofAnchorStatus(anchors: readonly PublicLedgerAnchor[]): ProofAnchorStatus {
  const succeeded = anchors.filter((anchor) => anchor.status === "ok");
  // The list arrives newest-first; take the newest successful one without assuming the caller sorted.
  let newest: PublicLedgerAnchor | undefined;
  for (const anchor of succeeded) {
    if (!newest || Date.parse(anchor.createdAt) > Date.parse(newest.createdAt)) newest = anchor;
  }
  if (!newest) return { state: "not_yet_anchored" };
  return { state: "anchored", backend: newest.backend, seq: newest.seq, rowHash: newest.rowHash, at: newest.createdAt };
}

/** Project a ledger-verify result onto the page's status. An empty ledger is `empty`, not `verified`:
 *  "nothing has been decided yet" and "everything checks out" are different claims. */
export function buildProofLedgerStatus(
  verify: { ok: boolean; tipSeq: number; totalCount: number; prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number; break?: { kind: string; atSeq: number } | undefined } | null,
  checkedAt: string,
): ProofLedgerStatus {
  if (!verify) return { state: "unavailable", checkedAt };
  if (verify.totalCount === 0) return { state: "empty", checkedAt };
  // #10012: carry the declared exclusions (pruned preimages + content/unchained waivers) so the badge can say
  // "verified · N excluded" instead of a bare "verified" that hides them -- an internal verifier that reports
  // waivers must not render as unqualified "verified" on the most public surface.
  if (verify.ok) return { state: "verified", tipSeq: verify.tipSeq, totalCount: verify.totalCount, checkedAt, prunedRecords: verify.prunedRecords, waivedContentMismatches: verify.waivedContentMismatches, waivedUnchainedRecords: verify.waivedUnchainedRecords };
  return {
    state: "broken",
    tipSeq: verify.tipSeq,
    totalCount: verify.totalCount,
    checkedAt,
    // A break with no position still renders as broken; -1 marks "broken, position unknown" rather than
    // silently claiming seq 0, which is a real position. Same for an unnamed kind.
    brokenAtSeq: verify.break?.atSeq ?? -1,
    brokenKind: verify.break?.kind ?? "unknown",
  };
}

/**
 * Compose the public proof summary from already-public inputs.
 *
 * Every field is copied out BY NAME (see the header's privacy note), so this function cannot leak a field
 * a future upstream type grows. `sampleRecords` is bounded and each entry is likewise rebuilt field by
 * field rather than spread from a wider record.
 */
export function buildProofSummary(input: {
  repoFullName: string;
  decisionCount: number;
  decided: number;
  confirmed: number | null;
  verify: { ok: boolean; tipSeq: number; totalCount: number; prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number; break?: { kind: string; atSeq: number } | undefined } | null;
  anchors: readonly PublicLedgerAnchor[];
  records: ReadonlyArray<{ pullNumber: number; action: string; reasonCode: string; decidedAt: string; recordDigest: string }>;
  checkedAt: string;
}): ProofSummary {
  return {
    schemaVersion: 1,
    repoFullName: input.repoFullName,
    decisionCount: input.decisionCount,
    accuracy: buildProofAccuracy(input.decided, input.confirmed),
    ledger: buildProofLedgerStatus(input.verify, input.checkedAt),
    anchor: buildProofAnchorStatus(input.anchors),
    sampleRecords: input.records.slice(0, PROOF_SAMPLE_RECORDS).map((record) => ({
      pullNumber: record.pullNumber,
      action: record.action,
      reasonCode: record.reasonCode,
      decidedAt: record.decidedAt,
      recordDigest: record.recordDigest,
    })),
    boundary: PROOF_BOUNDARY_STATEMENT,
  };
}

/** The proof badge's message — deliberately the LEDGER's state rather than an accuracy percentage. A badge
 *  is a one-glance claim, and "verified" is a claim this system can actually stand behind at a glance;
 *  an accuracy number without its interval (which does not fit in a badge) would be exactly the bare
 *  scalar this module exists to avoid. */
export function buildProofBadgeMessage(summary: ProofSummary): string {
  switch (summary.ledger.state) {
    case "verified": {
      // #10012: a clean chain that nonetheless carries declared exclusions (pruned preimages or content/
      // unchained waivers) is "verified · N excluded", never a bare "verified · anchored" that hides them.
      const excluded = summary.ledger.prunedRecords + summary.ledger.waivedContentMismatches + summary.ledger.waivedUnchainedRecords;
      if (excluded > 0) return `verified · ${excluded} excluded`;
      return summary.anchor.state === "anchored" ? "verified · anchored" : "verified";
    }
    case "broken":
      return "chain broken";
    case "empty":
      return "no decisions yet";
    default:
      return "unavailable";
  }
}

export function buildProofBadgeColor(summary: ProofSummary): string {
  switch (summary.ledger.state) {
    case "verified": {
      // #10012: a "verified · N excluded" badge is neutral grey, not the confident green — the exclusions are
      // exactly what the green would over-claim past.
      const excluded = summary.ledger.prunedRecords + summary.ledger.waivedContentMismatches + summary.ledger.waivedUnchainedRecords;
      if (excluded > 0) return "#9e9e9e";
      return summary.anchor.state === "anchored" ? "#3fb950" : "#2da44e";
    }
    case "broken":
      return "#f85149";
    // Neutral, not alarming: a repo with nothing decided yet has not failed anything.
    default:
      return "#9e9e9e";
  }
}

// ── DECISION: THE PROOF PAGE IS OPT-**OUT**, PER REPO, DEFAULT ON WHEN THE OPERATOR ENABLES IT ────────
// (#9569 requirement 6 asks for this to be decided and recorded; here it is, next to the code that
// implements it, rather than only in an issue comment that the code could drift away from.)
//
// Opt-OUT rather than opt-in, because every figure this page renders is ALREADY publicly fetchable today:
// `/v1/public/decision-ledger/verify`, `/v1/public/decision-ledger/anchors` and
// `/v1/public/decision-records/...` are unauthenticated by design and were argued as public-safe when they
// shipped. Gating a PAGE over data anyone can already curl would add friction without adding privacy --
// security theater, and the kind that makes a verification story look less confident than it is.
//
// A per-repo opt-out still exists, because a page is a genuinely different artifact from an API: it is
// discoverable, linkable, indexable, and it markets a repo's numbers whether or not the maintainer wants
// them marketed. "Anyone could assemble this" and "we assembled it for you and gave it a URL" are not the
// same act, so the maintainer keeps a switch.
//
// Two gates, both of which must allow: the operator's fleet-wide flag (default OFF, like every sibling
// public surface), and the repo's own manifest setting (default ON once the operator has opted in).

export type ProofPageRepoOverride = { present: boolean; enabled: boolean };

/**
 * Load ONE repo's `publicProof:` opt-out from its own focus manifest.
 *
 * Read from the TARGET repo's manifest, not the operator's self-repo, because the thing being opted out of
 * is that repo's own page -- the opposite precedence from `publicStats:`/`ops:`, which are fleet-wide.
 *
 * A manifest load failure degrades to `{ present: false }`, i.e. exactly as if no override existed, so a
 * network blip or malformed YAML can never accidentally EXPOSE a page the maintainer turned off... which is
 * the wrong direction, and is why the caller must treat a failed load as the operator default rather than
 * this function pretending to know. Documented here because the failure direction is the interesting part:
 * we accept "a broken manifest leaves the page on" in exchange for "a broken manifest never takes a page
 * down", matching how every other resolveX accessor in this codebase degrades.
 */
export async function loadProofPageRepoOverride(
  env: Env,
  repoFullName: string,
  loadManifest: (env: Env, repoFullName: string) => Promise<{ publicProof: { present: boolean; enabled: boolean } } | null>,
): Promise<ProofPageRepoOverride> {
  // try/catch, NOT `.catch()`: a loader that throws SYNCHRONOUSLY (a driver-level failure before it ever
  // returns a promise) skips a promise handler entirely, and the throw would escape to the route and 503 a
  // public page over a manifest read that is supposed to be optional. Same defect this file already had in
  // loadProofSummary's section reads.
  let manifest: { publicProof: { present: boolean; enabled: boolean } } | null = null;
  try {
    manifest = await loadManifest(env, repoFullName);
  } catch {
    return { present: false, enabled: false };
  }
  if (!manifest?.publicProof?.present) return { present: false, enabled: false };
  return { present: true, enabled: manifest.publicProof.enabled };
}

/** Fleet-wide operator flag -- truthy-string, default OFF, matching isPublicStatsEnabled's convention. */
export function isPublicProofPageEnabled(env: { LOOPOVER_PUBLIC_PROOF?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.LOOPOVER_PUBLIC_PROOF ?? "");
}

/**
 * The effective gate for ONE repo: the operator flag AND the repo's own opt-out.
 *
 * An absent repo override means ON (opt-out, per the decision above). An operator flag that is off wins
 * outright -- a repo cannot opt INTO a surface the operator has not enabled, which keeps the fleet-wide
 * switch a real switch rather than a default a repo can override.
 */
export function isProofPageEnabledForRepo(
  env: { LOOPOVER_PUBLIC_PROOF?: string | undefined },
  repoOverride?: ProofPageRepoOverride | undefined,
): boolean {
  if (!isPublicProofPageEnabled(env)) return false;
  return repoOverride?.present ? repoOverride.enabled : true;
}

/**
 * Load one repo's proof summary from the SAME public sources the standalone endpoints serve.
 *
 * No new SQL surface and no new verification mechanism (#9569's own boundary): the decision counts come
 * from `decision_records`, the chain status from the shared `verifyDecisionLedger`, the anchor from the
 * public attempt log, and the samples from records already published individually. Every read is wrapped
 * so one failing section degrades to its honest neutral state rather than failing the whole page --
 * matching `loadPublicRulePrecision`'s own fail-safe-per-section contract.
 */
export async function loadProofSummary(
  env: Env,
  repoFullName: string,
  deps: {
    verifyLedger: (env: Env) => Promise<{ ok: boolean; tipSeq: number; totalCount: number; prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number; break?: { kind: string; atSeq: number } | undefined }>;
    loadAnchors: (env: Env) => Promise<{ anchors: PublicLedgerAnchor[] }>;
    now?: () => string;
  },
): Promise<ProofSummary> {
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();

  // `.catch()` alone is NOT enough here: `DB.prepare()` throws SYNCHRONOUSLY on a driver-level failure, so
  // the rejection never reaches a promise handler and the whole page 503s instead of degrading. Each
  // section is therefore wrapped in a real try/catch. That is the difference between the fail-safe-per-
  // section contract being documented and it being true.
  const section = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch {
      return fallback;
    }
  };

  const counts = await section(
    () =>
      env.DB.prepare(
        `SELECT COUNT(*) AS decisionCount,
                SUM(CASE WHEN action IN ('merge', 'close') THEN 1 ELSE 0 END) AS decided
           FROM decision_records WHERE repo_full_name = ?`,
      )
        .bind(repoFullName)
        .first<{ decisionCount: number | null; decided: number | null }>(),
    null,
  );

  // #10012: `confirmed` counts merge/close decisions this repo made that were NOT later reversed. Reversals
  // are recorded as separate audit_events rows (reversal_reverted / reversal_reopened / reversal_superseded,
  // per public-rule-precision's own treatment of the same events), NOT as a reason_code on the decision row --
  // decision_records.reason_code is written once at decision time and can never be 'reversal…', so the old
  // `reason_code NOT LIKE 'reversal%'` made confirmed === decided for every repo, publishing accuracy = 1 by
  // construction. Anti-join against the reversal audit rows keyed by `<repo>#<pull>`. Its OWN section so a
  // failing read degrades toward NOT asserting a rate (buildProofSummary reads a null `confirmed` as
  // insufficient_data) rather than fabricating one.
  const confirmedRow = await section(
    () =>
      env.DB.prepare(
        `SELECT COUNT(*) AS confirmed
           FROM decision_records d
          WHERE d.repo_full_name = ? AND d.action IN ('merge', 'close')
            AND NOT EXISTS (
              SELECT 1 FROM audit_events a
               WHERE a.event_type IN ('reversal_reverted', 'reversal_reopened', 'reversal_superseded')
                 AND a.target_key = d.repo_full_name || '#' || d.pull_number
            )`,
      )
        .bind(repoFullName)
        .first<{ confirmed: number | null }>(),
    null,
  );

  const records = await section(
    async () =>
      (
        await env.DB.prepare(
          `SELECT pull_number AS pullNumber, action, reason_code AS reasonCode, created_at AS decidedAt, record_digest AS recordDigest
             FROM decision_records WHERE repo_full_name = ? ORDER BY created_at DESC LIMIT ?`,
        )
          .bind(repoFullName, PROOF_SAMPLE_RECORDS)
          .all<{ pullNumber: number; action: string; reasonCode: string; decidedAt: string; recordDigest: string }>()
      ).results ?? [],
    [] as Array<{ pullNumber: number; action: string; reasonCode: string; decidedAt: string; recordDigest: string }>,
  );

  const verify = await section(() => deps.verifyLedger(env), null);
  const anchors = await section(async () => (await deps.loadAnchors(env)).anchors, [] as PublicLedgerAnchor[]);

  return buildProofSummary({
    repoFullName,
    // SUM/COUNT over an empty table yield NULL/0 respectively -- both nullish arms are real and both
    // degrade to 0, which renders as the honest "no decisions yet" state rather than a fabricated rate.
    decisionCount: counts?.decisionCount ?? 0,
    decided: counts?.decided ?? 0,
    // #10012: null (not 0) when the reversal read FAILED (section returned null), so buildProofAccuracy
    // degrades to insufficient_data rather than publishing a fabricated rate. A successful read always has a
    // numeric COUNT(*) (never SQL NULL), so the inner `?? 0` is a defensive floor no input reaches.
    /* v8 ignore next -- COUNT(*) is never NULL on a successful read; the `?? 0` is a defensive floor */
    confirmed: confirmedRow ? confirmedRow.confirmed ?? 0 : null,
    verify,
    anchors,
    records,
    checkedAt,
  });
}

/** Everything the proof surfaces read, injected as one bag. The routes bind the real implementations; tests
 *  bind failing ones, which is what makes the unavailable path a tested outcome rather than a hoped-for one. */
export type ProofPageDeps = {
  loadManifest: (env: Env, repoFullName: string) => Promise<{ publicProof: { present: boolean; enabled: boolean } } | null>;
  verifyLedger: (env: Env) => Promise<{ ok: boolean; tipSeq: number; totalCount: number; prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number; break?: { kind: string; atSeq: number } | undefined }>;
  loadAnchors: (env: Env) => Promise<{ anchors: PublicLedgerAnchor[] }>;
  now?: (() => string) | undefined;
};

/** The two outcomes both proof surfaces share. The JSON route and the badge route render them differently;
 *  deciding them is not theirs to duplicate.
 *
 *  There is deliberately NO `unavailable` case. `loadProofSummary` is TOTAL: every read it performs is
 *  wrapped per section, so a failing ledger, anchor or decision-record read degrades to that section's
 *  honest neutral state and the page still composes. Carrying a 503 outcome would mean carrying a branch
 *  no input can reach -- dead code that a test can only reach by faking a dependency contract violation,
 *  which proves nothing about the system. If a future read is ever added outside that per-section
 *  discipline, the fix is to wrap it there (where the honest-degradation tests live), not to reintroduce a
 *  catch-all here that would silently turn a partial page into a blank 503. */
export type ProofPageResult =
  | { status: "ok"; summary: ProofSummary }
  | { status: "disabled" };

/**
 * Resolve what a proof surface should serve for one repo: the gate, the read, and the failure outcome.
 *
 * This exists as ONE function because the alternative already bit us: the gate lived inline in two route
 * bodies, and exactly one of them was wired to the per-repo opt-out while the other silently was not. A
 * shared resolver makes "the badge and the page agree about whether this repo is published" true by
 * construction rather than by two call sites remembering the same thing.
 *
 * The override is resolved FIRST, so a repo that turned its page off never has its decision records queried
 * to build a summary that would be discarded.
 */
export async function resolveProofPage(env: Env, repoFullName: string, deps: ProofPageDeps): Promise<ProofPageResult> {
  const override = await loadProofPageRepoOverride(env, repoFullName, deps.loadManifest);
  if (!isProofPageEnabledForRepo(env, override)) return { status: "disabled" };
  const summary = await loadProofSummary(env, repoFullName, {
    verifyLedger: deps.verifyLedger,
    loadAnchors: deps.loadAnchors,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return { status: "ok", summary };
}
