// AI-assisted slop advisory gating and orchestration (#4013 step 4 -- extracted from processors.ts, fourth
// step of the file's own module-split sequence, after transient-locks.ts, signal-snapshot.ts, and
// duplicate-detection.ts). Pure move. mergeReadinessGateEnabled (a trivial one-line predicate, also used by
// processors.ts's own shouldCollectLinkedIssueEvidence there) is inlined directly rather than imported back
// from processors.ts, for the same reason githubAdmissionKeyForToken was inlined in duplicate-detection.ts
// -- it would otherwise make the two files circularly dependent on each other for one line of logic.

import { getCachedAiSlopAdvisory, getDecryptedRepositoryAiKey, type listPullRequestFiles, putCachedAiSlopAdvisory, recordAuditEvent } from "../db/repositories";
import { buildPullRequestAdvisory } from "../rules/advisory";
import { buildAiReviewDiff } from "../review/review-diff";
import { aiSlopCacheInputFingerprint } from "../review/ai-slop-cache-input";
import { withAdvisoryAiEnv } from "../selfhost/ai";
import { incr } from "../selfhost/metrics";
import { runGittensoryAiSlopAdvisory } from "../services/ai-slop";
import type { AgentActionMode } from "../settings/agent-execution";
import type { SlopBand } from "../signals/slop";
import type { RepositorySettings } from "../types";
import { errorMessage } from "../utils/json";

export function shouldCollectSlopEvidence(
  settings: Pick<RepositorySettings, "slopGateMode" | "mergeReadinessGateMode">,
): boolean {
  return settings.slopGateMode !== "off" || settings.mergeReadinessGateMode !== "off";
}

export function shouldRunSlopAiAdvisory(
  settings: Pick<RepositorySettings, "slopAiAdvisory" | "slopGateMode">,
): boolean {
  return settings.slopAiAdvisory && settings.slopGateMode !== "off";
}

/**
 * AI-assisted slop advisory (opt-in `slopAiAdvisory`). Appends at most one ADVISORY-only `ai_slop_advisory`
 * finding to the advisory; NEVER touches slopRisk or the gate (only the deterministic core can block). The
 * caller gates on `settings.slopAiAdvisory` and reuses the already-fetched changed files. Like the AI review
 * path, it runs ONLY for confirmed contributors so an unconfirmed/untrusted PR author cannot spend either the
 * shared Workers AI budget or the maintainer-paid BYOK quota. Fail-safe: any AI error is swallowed so the
 * gate still finalizes.
 *
 * `commitThresholdReached` (#ai-slop-repeat-spend): mirrors `ai_review`'s OWN `auto_pause_after_reviewed_commits`
 * cap (`isAutoReviewCommitThresholdReached`) — a PR that's already been reviewed this many times at essentially
 * its current state stops getting a fresh slop advisory too. Before this, every sweep pass re-ran the FULL
 * advisory regardless of how many times the SAME head had already been checked (only a headSha+prompt-fingerprint
 * cache guarded re-spend, so a stale PR the sweep kept re-visiting paid for a fresh attempt on every pass).
 */
export async function runAiSlopForAdvisory(
  env: Env,
  args: {
    // See runAiReviewForAdvisory's doc comment on this same field (#token-bleed-spend-gate) -- a paused repo
    // must never reach the LLM call below, independent of settings.slopAiAdvisory.
    mode: AgentActionMode;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pr: { number: number; title: string; body?: string | null | undefined };
    author: string | null;
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    deterministicBand: SlopBand;
    confirmedContributor: boolean;
    commitThresholdReached: boolean;
  },
): Promise<void> {
  // Confirmed-contributor gate (matches runAiReviewForAdvisory): no AI spend — free OR BYOK — on a PR from
  // an unconfirmed author. The deterministic slop core still ran for everyone; only the AI layer is gated.
  if (args.mode === "paused" || !args.confirmedContributor || !args.advisory.headSha) return;
  if (args.commitThresholdReached) {
    await recordAuditEvent(env, {
      eventType: "github_app.ai_slop_auto_review_skipped",
      actor: args.author,
      targetKey: `${args.repoFullName}#${args.pr.number}`,
      outcome: "completed",
      detail: "slop advisory paused (commit threshold); this head has already been reviewed enough times",
      metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return;
  }
  try {
    // BYOK (opt-in): reuse the repo's encrypted key + aiReviewByok flag — one BYOK key serves both AI
    // features. A declared provider must match the stored key's provider, else skip BYOK (Workers-AI
    // fallback). The contributor is already confirmed (early return above), so BYOK billing is authorized.
    // The slop advisory stays advisory-only regardless of which model writes it.
    const storedKey = args.settings.aiReviewByok
      ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
      : null;
    const providerKey =
      storedKey &&
      (!args.settings.aiReviewProvider ||
        args.settings.aiReviewProvider === storedKey.provider)
        ? {
            provider: storedKey.provider,
            key: storedKey.key,
            model: args.settings.aiReviewModel ?? storedKey.model,
          }
        : null;
    // #ai-slop-cache: repeated scheduled sweeps at an unchanged prompt reuse the stored result instead of
    // re-spending up to 6 free-tier attempts (or a BYOK call) on every tick. The fingerprint includes the
    // provider identity plus the prompt-shaping inputs that can drift for the same head SHA (PR edits,
    // retarget/base-diff changes, or deterministic-band setting changes).
    const aiSlopDiff = buildAiReviewDiff(args.files);
    const inputFingerprint = await aiSlopCacheInputFingerprint({
      title: args.pr.title,
      body: args.pr.body ?? null,
      diff: aiSlopDiff,
      deterministicBand: args.deterministicBand,
      byok: Boolean(providerKey),
      provider: providerKey?.provider,
      model: providerKey?.model,
    });
    const cachedSlop = await getCachedAiSlopAdvisory(env, args.repoFullName, args.pr.number, args.advisory.headSha, inputFingerprint).catch(() => null);
    let result: Awaited<ReturnType<typeof runGittensoryAiSlopAdvisory>>;
    if (cachedSlop) {
      result = { status: "ok", finding: cachedSlop.finding, band: cachedSlop.band as SlopBand | null, estimatedNeurons: cachedSlop.estimatedNeurons };
      incr("loopover_ai_slop_cache_hit_total");
      await recordAuditEvent(env, {
        eventType: "github_app.ai_slop_cache_hit",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "reused a stored AI slop advisory instead of re-spending an LLM call",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
      }).catch(() => undefined);
    } else {
      incr("loopover_ai_slop_cache_miss_total");
      await recordAuditEvent(env, {
        eventType: "github_app.ai_slop_cache_miss",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "no reusable stored AI slop advisory for this head+fingerprint; running a fresh advisory",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
      }).catch(() => undefined);
      result = await runGittensoryAiSlopAdvisory(withAdvisoryAiEnv(env, args.settings.advisoryAiRouting?.slop === true), {
        repoFullName: args.repoFullName,
        prNumber: args.pr.number,
        title: args.pr.title,
        body: args.pr.body ?? undefined,
        diff: aiSlopDiff,
        actor: args.author,
        deterministicBand: args.deterministicBand,
        providerKey,
      });
      // Only "ok" actually spent the LLM call (free-tier attempts or a BYOK call) — disabled/unavailable/
      // quota_exceeded all short-circuit BEFORE any provider call, so caching them would suppress a legitimate
      // retry once the condition clears without having saved anything.
      if (result.status === "ok") {
        await putCachedAiSlopAdvisory(env, args.repoFullName, args.pr.number, args.advisory.headSha, inputFingerprint, {
          status: result.status,
          band: result.band,
          finding: result.finding,
          estimatedNeurons: result.estimatedNeurons,
        }).catch((error) => {
          incr("loopover_ai_slop_cache_write_error_total");
          return recordAuditEvent(env, {
            eventType: "github_app.ai_slop_cache_write_error",
            actor: args.author,
            targetKey: `${args.repoFullName}#${args.pr.number}`,
            outcome: "error",
            detail: errorMessage(error),
            /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
            metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
          }).catch(() => undefined);
        });
      }
    }
    if (result.status === "ok" && result.finding)
      args.advisory.findings.push(result.finding);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "ai_slop_failed",
        repository: args.repoFullName,
        pullNumber: args.pr.number,
        error: errorMessage(error),
      }),
    );
  }
}
