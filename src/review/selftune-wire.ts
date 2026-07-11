// Convergence (#self-improve) — wires the ported self-improvement loop (src/review/auto-tune.ts +
// src/review/auto-apply.ts) into gittensory's cron behind the default-OFF `GITTENSORY_REVIEW_SELFTUNE` flag.
//
// SAFETY CONTRACT (must hold under every path):
//   • flag-OFF (default) → the cron enqueues NO selftune job and this module is never reached; ZERO tuning
//     work, NO override read/written, the worker is byte-identical to today.
//   • flag-ON → the loop can ONLY EVER TIGHTEN the gate. It computes tuning recommendations from gittensory's
//     OWN outcome data, SHADOW-SOAKS only STRICTLY-TIGHTENING recommendations, and AUTO-PROMOTES a soaked
//     shadow override to live ONLY after the soak window passes the gate (tightening + evidence + soaked).
//     Every action is recorded to override_audit. A loosening change is NEVER applied — the ported
//     `isStrictlyTightening` / `evaluateShadowPromotion` reject it, and the eval mapping below NEVER feeds a
//     loosening directive into the apply path (closeFalse is held at 0, so the one loosening branch of
//     `computeTuningRecommendations` is unreachable and carries no payload anyway).
//
// EVAL INPUT — ADAPTED TO GITTENSORY'S OWN OUTCOME DATA (NOT reviewbot's review_audit, which does not exist in
// gittensory's migrations — parity.computeGateEval would read an empty table here). The ported auto-tune
// advisor consumes a GateEvalReport (per-project confusion matrix). We build that report from gittensory's
// NATIVE outcome sources via the SAME aggregation services ops-wire already reuses (no new queries / schema):
//   • agent_recommendation_outcomes (#543) — the positive/negative resolved split (buildRepoOutcomeCalibration).
//     Only maintainer-lane outcomes are authoritative enough for live self-tune policy changes; contributor-lane
//     closures can be self-authored and stay reporting-only. A maintainer-lane NEGATIVE outcome (gittensory
//     recommended "proceed", the human CLOSED) is the gittensory-native analogue of reviewbot's "would-merge
//     BUT human closed" (mergeFalse) — the dangerous error a TIGHTENING fixes.
// The mapping is deliberately conservative: it only ever populates the would-MERGE side of the matrix, so the
// advisor can only ever recommend a TIGHTENING (raise the floor) or a no-op — never a loosening.
//
// CONFIG-APPLICATION — WIRED (live read-back, tightening-only):
//   The ported override model is `confidenceFloor` (a proceed-confidence floor in [0,1]) + `scopeCap`. The live
//   read-back lives in resolveRepositorySettings → `applySelfTuneOverrideToSettings`, gated by the SAME default-OFF
//   GITTENSORY_REVIEW_SELFTUNE flag: it translates a promoted `confidenceFloor` into gittensory's NATIVE readiness
//   tunable by RAISING an EXISTING `qualityGateMinScore` to `round(confidenceFloor * 100)` via a `max()`. By
//   construction this can ONLY tighten — it never CREATES a readiness gate the operator didn't set, and never
//   LOWERS one — so the always-tightening recommendation (this module only ever populates the would-merge error
//   side, so the advisor can only raise the floor) reaches the live gate with no risk of loosening it. Flag-OFF
//   (default) the override is never read and settings are byte-identical. (See applySelfTuneOverrideToSettings.)

import { listRepositories } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { buildRepoOutcomeCalibration } from "../services/outcome-calibration";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { errorMessage } from "../utils/json";
import { computeTuningRecommendations, type GateEvalReport, type GateEvalRow } from "./auto-tune";
import { runAutoApplyRecommendations, type StorageEnv } from "./auto-apply";

/** True when the self-improvement loop is enabled. Flag-OFF (default) → every export below is a no-op. Truthy
 *  follows the codebase convention (`/^(1|true|yes|on)$/i`, same as isOpsEnabled / isReputationEnabled). */
export function isSelfTuneEnabled(env: { GITTENSORY_REVIEW_SELFTUNE?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_SELFTUNE ?? "");
}

/** The project's base confidence floor the tightening direction is judged against IN THE SOAK. Gittensory has no
 *  live `confidenceFloor` tunable (the live read-back instead RAISES `qualityGateMinScore` — see
 *  applySelfTuneOverrideToSettings), so a no-override project starts the soak from an UNSET base — the apply path
 *  treats "no live floor" as the loosest state, so any positive floor recommendation is strictly tightening (it
 *  can only HOLD more, never add a bad auto-merge). */
export const SELFTUNE_BASE_CONFIDENCE_FLOOR = 0;

/**
 * PURE: build the ported GateEvalReport from gittensory's NATIVE recommendation-outcome calibration. The
 * recommendation NEGATIVE outcomes (gittensory said proceed, the human CLOSED) map to the would-merge ERROR
 * (`mergeFalse`); POSITIVE outcomes map to `mergeConfirmed`. ONLY the would-merge side is populated, so the
 * advisor can ONLY produce a TIGHTENING (raise the floor) or no recommendation — never a loosening (the
 * close-side counters stay 0, so `computeTuningRecommendations`' one loosening branch is unreachable).
 * Unit-testable with no I/O.
 */
export function evalRowFromCalibration(project: string, positive: number, negative: number): GateEvalRow {
  const wouldMerge = positive + negative; // resolved recommendation outcomes graded against the human's call
  const decided = wouldMerge;
  return {
    project,
    wouldMerge,
    mergeConfirmed: positive,
    mergeFalse: negative, // the dangerous error: recommended-proceed but the human closed → tighten
    wouldClose: 0, // NEVER populate the close side — keeps the loop tightening-only (no loosening directive)
    closeConfirmed: 0,
    closeFalse: 0, // held at 0 by construction: the only loosening branch of the advisor is unreachable
    hold: 0,
    decided,
    mergePrecision: wouldMerge > 0 ? positive / wouldMerge : null,
    closePrecision: null,
  };
}

/** Build the per-project GateEvalReport from gittensory's recommendation-outcome calibration for one repo. */
async function buildEvalRow(env: Env, repoFullName: string): Promise<GateEvalRow> {
  const calibration = await buildRepoOutcomeCalibration(env, repoFullName, undefined, { maintainerOnly: true });
  return evalRowFromCalibration(repoFullName, calibration.recommendations.positive, calibration.recommendations.negative);
}

/** The registered, agent-configured repos to tune over — SAME scoping the ops scan + regate sweep use (only
 *  repos that opt into the acting-autonomy surface). A repo whose settings blip is skipped, never aborts.
 *
 *  Per-repo opt-out (#4104): unlike rag/reputation/grounding, selftune has no `GITTENSORY_REVIEW_REPOS`
 *  allowlist to fall back to — every agent-configured repo is already IN by default once the global flag is
 *  on. So this doesn't fit `resolveConvergedFeature`'s env-kill-switch → override → allowlist-default shape;
 *  there is no allowlist. Instead, deliberately FORCE-OFF-ONLY (mirroring the `safety` feature's asymmetric
 *  precedent, #2269, just in the opposite direction): an explicit per-repo `.gittensory.yml`
 *  `review.selftune: false` excludes that one repo from the tuning pass even though it's otherwise
 *  agent-configured. There is no `true` override — forcing a NON-agent-configured repo INTO the tuning pass
 *  would bypass its owner's separate, broader acting-autonomy consent (`isAgentConfigured`), an unrelated
 *  safety boundary this config key must not touch. Unset (the default) changes nothing. A manifest-load error
 *  fails open (repo stays included), matching the existing settings-blip fail-safe below. */
async function selfTuneRepos(env: Env): Promise<string[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  const configured: string[] = [];
  for (const repo of repos) {
    try {
      // #sweep-requires-installation: a repo with no real GitHub App installation must never be treated as
      // agent-configured purely because it resolves the operator's global-default autonomy by merely having
      // a local row -- mirrors fanOutAgentRegateSweepJobs's own guard.
      if (typeof repo.installationId !== "number") continue;
      const settings = await resolveRepositorySettings(env, repo.fullName);
      if (!isAgentConfigured(settings.autonomy)) continue;
      const manifest = await loadRepoFocusManifest(env, repo.fullName).catch(() => null);
      if (manifest?.review.selftune === false) continue; // explicit per-repo opt-out
      configured.push(repo.fullName);
    } catch {
      /* a settings blip on one repo must not abort the whole tuning pass */
    }
  }
  return configured;
}

/**
 * One self-improvement tick, run on the cron. FAILS SAFE: a per-repo error is logged and the pass continues; a
 * top-level error is swallowed (tuning must never break the cron). For each agent-configured repo it: (1) builds
 * the GateEvalReport from gittensory's own outcome data; (2) computes tuning recommendations; (3) SHADOW-SOAKS
 * any strictly-tightening recommendation; (4) PROMOTES a soaked shadow override to live ONLY when the gate
 * passes (tightening + evidence + soaked) — all via the ported runAutoApplyRecommendations, which records every
 * action to override_audit and NEVER applies a loosening change.
 *
 * Caller MUST gate this on {@link isSelfTuneEnabled}: it is invoked only from the flag-ON cron path, so flag-OFF
 * this function is never reached and the cron does ZERO new work.
 */
export async function runSelfTune(env: Env): Promise<void> {
  try {
    const repos = await selfTuneRepos(env);
    const nowMs = Date.now();
    for (const repoFullName of repos) {
      try {
        const row = await buildEvalRow(env, repoFullName);
        const report: GateEvalReport = { rows: [row], hasSignal: row.decided >= 10 };
        const recs = computeTuningRecommendations(report);
        // runAutoApplyRecommendations only ever consumes recs that carry a TIGHTENING overridePayload, shadow-
        // soaks them, and promotes a soaked override only when isStrictlyTightening + evidence + soak pass.
        await runAutoApplyRecommendations(env as unknown as StorageEnv, {
          project: repoFullName,
          autoTune: true, // this repo opted into the acting-autonomy surface (selfTuneRepos filtered)
          baseConfidenceFloor: SELFTUNE_BASE_CONFIDENCE_FLOOR,
          decided: row.decided,
          recs,
          nowMs,
        });
      } catch (error) {
        console.warn(JSON.stringify({ event: "selftune_repo_error", repo: repoFullName, message: errorMessage(error).slice(0, 200) }));
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "selftune_error", message: errorMessage(error).slice(0, 200) }));
  }
}
