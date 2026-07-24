// Evidence-weighted reviewer routing, STAGE 1 of #8229 (epic #8211 track F): the report-only shadow.
// After each ok block-mode dual review, compute what routing WOULD have preferred for this repo from the
// live per-provider track records (#8228 over the stage-0 reviewer_vote rows) and record it — one audit
// event plus a maintainer-recap section — while changing NOTHING about the review itself. Stage 2 (actual
// weighting behind a default-off flag, hard floors, instant restore) ships only against this stage's
// recorded evidence, per the issue's two-stage contract.
//
// Invariants the shadow holds (each pinned by a test):
//   • ZERO behavior change and ZERO added AI spend — pure DB reads, one best-effort audit write;
//   • fail-safe: any read/compute error ⇒ no record, review path byte-identical;
//   • never a preference on noise — a per-(provider, repo) decided floor below which NOTHING records
//     ({@link ROUTING_MIN_DECIDED}, the AUTOTUNE_MIN_DECIDED never-on-noise bar at reviewer grain);
//   • a tie (or a lone provider) records nothing — absence of a record must mean "no measurable
//     preference", so the eventual stage-2 evidence read is never diluted by no-signal rows.
import { buildBacktestCorpus, computeProviderTrackRecords, type ProviderReviewSignal, type ProviderTrackRecord } from "@loopover/engine";
import { createSignalStore } from "../review/signal-tracking-wire";
import { recordAuditEvent } from "../db/repositories";

/** Audit event type a shadow decision writes — ONE stable type forever (the #8159 event discipline). */
export const REVIEWER_ROUTING_SHADOW_EVENT_TYPE = "reviewer_routing_shadow";

/** Minimum DECIDED votes per (provider, repo) before a preference may record — AUTOTUNE_MIN_DECIDED's
 *  never-on-noise bar (auto-tune.ts) applied at reviewer grain, as #8229's own floors clause requires. */
export const ROUTING_MIN_DECIDED = 10;

/** The trailing window the track-record read replays — mirrors the calibration corpus lookback. */
const CORPUS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

export type RoutingShadowDecision = {
  repoFullName: string;
  preferredProvider: string;
  actualProviders: string[];
  /** The evidence the preference rests on — repo-scoped decided/precision per actual provider. */
  basis: Array<{ provider: string; decided: number; precision: number }>;
};

/**
 * PURE: what would evidence-weighted routing have preferred for this repo, given the current track
 * records and the providers the review ACTUALLY used? Null — record nothing — unless EVERY actual
 * provider has a repo-scoped row at/above the decided floor with a non-null precision, and exactly one
 * provider strictly leads. Repo-scoped rows only: the per-(provider, repo) floor is the issue's own
 * requirement, and a global rollup preference would smuggle cross-repo behavior into a per-repo call.
 */
export function computeWouldHaveRouted(
  records: readonly ProviderTrackRecord[],
  repoFullName: string,
  actualProviders: readonly string[],
): RoutingShadowDecision | null {
  if (actualProviders.length < 2) return null; // a lone reviewer has nothing to route between
  const basis: Array<{ provider: string; decided: number; precision: number }> = [];
  for (const provider of actualProviders) {
    const row = records.find((record) => record.provider === provider && record.repoFullName === repoFullName);
    if (!row || row.decided < ROUTING_MIN_DECIDED || row.precision === null) return null;
    basis.push({ provider, decided: row.decided, precision: row.precision });
  }
  const sorted = [...basis].sort((a, b) => b.precision - a.precision);
  if (sorted[0]!.precision === sorted[1]!.precision) return null; // a tie is not a preference
  return {
    repoFullName,
    preferredProvider: sorted[0]!.provider,
    actualProviders: [...actualProviders],
    basis,
  };
}

/**
 * Load the LIVE provider track records: stage-0 reviewer_vote rows joined to the labeled consensus corpus
 * via the #8228 aggregation. Replay-derived signals never enter here — this reads only the live event
 * type (the #8278 segregation rule from the consuming side). Fail-safe empty on any store error.
 */
export async function loadLiveProviderTrackRecords(env: Env, nowMs: number = Date.now()): Promise<ProviderTrackRecord[]> {
  try {
    const votes = await env.DB.prepare(
      "SELECT actor, target_key, metadata_json FROM audit_events WHERE event_type = ? AND created_at >= ?",
    )
      .bind(REVIEWER_VOTE_EVENT_TYPE, new Date(nowMs - CORPUS_LOOKBACK_MS).toISOString())
      .all<{ actor: string; target_key: string; metadata_json: string }>();
    const signals: ProviderReviewSignal[] = [];
    /* v8 ignore next -- defined-results guard, the loadKnobStatus convention */
    for (const row of votes.results ?? []) {
      let metadata: { repoFullName?: unknown; vote?: unknown } = {};
      try {
        metadata = JSON.parse(row.metadata_json) as { repoFullName?: unknown; vote?: unknown };
      } catch {
        continue; // a corrupt vote row is not evidence
      }
      if (typeof metadata.repoFullName !== "string" || (metadata.vote !== "fail" && metadata.vote !== "non_fail")) continue;
      signals.push({
        provider: row.actor,
        repoFullName: metadata.repoFullName,
        targetKey: row.target_key,
        vote: metadata.vote === "fail" ? "fail" : "pass",
      });
    }
    const { fired, overrides } = await createSignalStore(env).queryRuleHistory("ai_consensus_defect", nowMs - CORPUS_LOOKBACK_MS);
    return computeProviderTrackRecords(signals, buildBacktestCorpus("ai_consensus_defect", fired, overrides));
  } catch {
    return []; // fail-safe: no records ⇒ downstream records nothing ⇒ byte-identical behavior
  }
}

/** The stage-0 vote event type, mirrored here as the ONE consuming-side constant (the orchestration writer
 *  keeps its literal; the invariant test pins the two spellings together so they can never drift). */
export const REVIEWER_VOTE_EVENT_TYPE = "reviewer_vote";

/**
 * The orchestration hook: compute + record this review's shadow decision, best-effort end to end. Never
 * throws, never adds an AI call; a null decision (no density / tie / lone reviewer / read error) writes
 * NOTHING. Called after the stage-0 vote persistence with the same swap-proof reviewer identities.
 */
export async function recordRoutingShadow(
  env: Env,
  args: { repoFullName: string; prNumber: number; actualProviders: readonly string[] },
): Promise<RoutingShadowDecision | null> {
  try {
    const decision = computeWouldHaveRouted(await loadLiveProviderTrackRecords(env), args.repoFullName, args.actualProviders);
    if (!decision) return null;
    await recordAuditEvent(env, {
      eventType: REVIEWER_ROUTING_SHADOW_EVENT_TYPE,
      actor: "loopover",
      targetKey: `${args.repoFullName}#${args.prNumber}`,
      outcome: "completed",
      detail: `routing would have preferred ${decision.preferredProvider} (report-only shadow; review used ${decision.actualProviders.join(" + ")})`,
      metadata: { ...decision },
    }).catch(() => undefined);
    return decision;
  } catch {
    return null; // the shadow must never touch the review path
  }
}
