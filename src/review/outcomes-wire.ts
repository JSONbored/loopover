// Convergence (#self-improve / GAP-4) — the accuracy/eval FEEDBACK LOOP recording + circuit-breaker wiring.
//
// This is the half of GAP-4 that lets the bot SEE the outcomes of its own decisions and self-correct. The pure
// calibration logic already exists (src/review/auto-tune.ts: planAutoTune / applyAutoTune / maybeAutoClearHoldOnly,
// and src/review/parity.ts: computeGateEval); this module closes the loop by:
//   1. RECORDING GROUND TRUTH — when a PR closes, a `pr_outcome` row (merged vs closed) so computeGateEval can
//      score the gate's prediction (gate_decision) against what the human actually did.
//   2. RECORDING REVERSALS — when a HUMAN undoes a bot action (a bot-closed PR reopened, or a bot-merged PR
//      reverted), a `reversal_reopened` / `reversal_reverted` row. This un-blinds the reversalRate/calibration
//      reads (ops.ts already READS these but, with no writer, they sat at 0).
//   3. The live D1-backed FlagStore (system_flags, migration 0054) the precision circuit-breaker engages /
//      clears + reads, so applyAutoTune / maybeAutoClearHoldOnly and the merge→hold downgrade have real storage.
//
// STORAGE: the realized outcome + reversal rows are written to BOTH
//   • `review_audit` — the canonical eval/parity store (migration 0049). computeGateEval reads
//     event_type='pr_outcome' (decision column) joined to event_type='gate_decision' here; ops.ts joins
//     reversal_* rows to review_targets. This is the store the feedback loop actually consumes.
//   • `audit_events` — the general product-audit ledger, via the existing recordAuditEvent helper (per the
//     GAP-4 task), so the outcome/reversal is also visible on the standard audit surface.
// Both writes are best-effort (a failure is swallowed); recording telemetry must never break the webhook.
//
// FAIL-SAFE / BYTE-IDENTICAL CONTRACT: with no pr_outcome/reversal history yet, computeGateEval reads neutral →
// applyAutoTune engages nothing → isHoldOnly is false → the merge path is unchanged. The breaker only engages
// once a repo's merge precision actually drops below the floor over a real sample.

import { recordAuditEvent } from "../db/repositories";
import { tryEnqueueDecisionPackRebuild } from "../services/decision-pack";
import { incr } from "../selfhost/metrics";
import type { GitHubWebhookPayload } from "../types";
import { errorMessage, nowIso } from "../utils/json";
import {
  applyAutoTune,
  applyCloseAutoTune,
  AUTOTUNE_CLOSE_PRECISION_FLOOR,
  AUTOTUNE_MERGE_PRECISION_FLOOR,
  type FlagStore,
  type GateEvalReport,
  maybeAutoClearCloseHoldOnly,
  maybeAutoClearHoldOnly,
} from "./auto-tune";
import { computeGateEval } from "./parity";
import { GITTENSORY_NATIVE_SOURCE } from "./parity-wire";

/** PURE: parse the PR number an "Reverts #N / Reverts owner/repo#N" body refers to (GitHub's revert PRs).
 *  Mirrors reviewbot runtime.ts parseRevertedPrNumber. Returns undefined when the body isn't a revert. */
export function parseRevertedPrNumber(
  body: string | null | undefined,
): number | undefined {
  const m = /Reverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i.exec(body ?? "");
  return m ? Number(m[1]) : undefined;
}

// ── Live D1-backed FlagStore (system_flags, migration 0054) ─────────────────────────────────────────────────
// Byte-faithful to the reviewbot src/core/system-flags.ts holdonly accessors. <scope> is `global` or a repo full
// name. Both reads fail OPEN (false / null) on a DB blip — a fault must never silently change behavior.

function flagTruthy(v: string | null | undefined): boolean {
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Is auto-merge disabled (would-merge → hold) for this project (or globally)? Fail-OPEN (false) on a DB error.
 *  This is the read the merge path consults to downgrade a would-MERGE into a HOLD. */
export async function isHoldOnly(
  env: Env,
  project: string,
  minerAuthored = false,
): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      "SELECT key, value FROM system_flags",
    ).all<{ key: string; value: string }>();
    const set = new Set<string>();
    for (const r of res.results ?? []) if (flagTruthy(r.value)) set.add(r.key);
    return (
      set.has("holdonly:global") ||
      set.has(`holdonly:${project}`) ||
      (minerAuthored && set.has(`holdonly:${minerBreakerScope(project)}`))
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "flags_read_error",
        message: errorMessage(error).slice(0, 120),
      }),
    );
    return false; // fail-OPEN: a DB blip must never silently change the merge path
  }
}

/** CLOSE-side mirror of {@link isHoldOnly}: is auto-CLOSE disabled (would-close → hold) for this project (or
 *  globally)? Reads the SAME system_flags table via a single scan and tests the `closehold:` namespace. This is
 *  the read the close path consults to downgrade a would-CLOSE into a HOLD. Fail-OPEN (false) on a DB error so a
 *  blip never silently changes the close path. */
export async function isCloseHoldOnly(
  env: Env,
  project: string,
  minerAuthored = false,
): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      "SELECT key, value FROM system_flags",
    ).all<{ key: string; value: string }>();
    const set = new Set<string>();
    for (const r of res.results ?? []) if (flagTruthy(r.value)) set.add(r.key);
    return (
      set.has("closehold:global") ||
      set.has(`closehold:${project}`) ||
      (minerAuthored && set.has(`closehold:${minerBreakerScope(project)}`))
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "flags_read_error",
        message: errorMessage(error).slice(0, 120),
      }),
    );
    return false; // fail-OPEN: a DB blip must never silently change the close path
  }
}

/** Every project currently holding a PER-PROJECT (not `:global`) `holdonly:`/`closehold:` flag. Used ONLY to
 *  widen the auto-clear tick's candidate set beyond `report.rows` (#autoclear-deadlock) — the eval report only
 *  contains a project once it has a fresh DECIDED sample in the window, but a breaker that is suppressing every
 *  merge/close for a project stops that project from producing new decided samples at all, so a project with no
 *  OTHER (e.g. merge-side) activity can silently never reappear in `report.rows` and its stuck flag would never
 *  be reconsidered. `:global` is deliberately excluded here (mirrors {@link shouldAutoClear}: a human-set global
 *  freeze is never auto-cleared, so it must never enter an auto-clear candidate set). Fail-open (empty) on a DB
 *  error, matching every other flag read in this module. */
async function listEngagedProjectScopes(env: Env): Promise<{ holdonly: string[]; closehold: string[] }> {
  try {
    const res = await env.DB.prepare(
      "SELECT key, value FROM system_flags WHERE key LIKE 'holdonly:%' OR key LIKE 'closehold:%'",
    ).all<{ key: string; value: string }>();
    const holdonly: string[] = [];
    const closehold: string[] = [];
    for (const row of res.results ?? []) {
      if (!flagTruthy(row.value)) continue;
      const [prefix, ...rest] = row.key.split(":");
      const project = rest.join(":");
      if (!project || project === "global") continue;
      // The SQL WHERE clause above only ever matches a "holdonly:" or "closehold:" key, so prefix can never be
      // anything else here — a plain else (not another === check) so there is no unreachable branch to cover.
      // If the WHERE clause ever grows a third prefix, this must go back to an explicit `else if (prefix ===
      // "closehold")` (with a new branch/test for the resulting default case) so an unrecognized prefix is
      // never silently miscategorized as closehold.
      if (prefix === "holdonly") holdonly.push(project);
      else closehold.push(project);
    }
    return { holdonly, closehold };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "flags_read_error",
        message: errorMessage(error).slice(0, 120),
      }),
    );
    return { holdonly: [], closehold: [] };
  }
}

/** A live FlagStore over system_flags for the circuit-breaker (applyAutoTune / maybeAutoClearHoldOnly +
 *  applyCloseAutoTune / maybeAutoClearCloseHoldOnly). */
export function createFlagStore(env: Env): FlagStore {
  return {
    async isHoldOnly(project: string): Promise<boolean> {
      // Per-key check (NOT the global-or-project read above): applyAutoTune dedups on whether THIS project's
      // breaker is already engaged, so it must read the per-project key, not fold in the global one.
      try {
        const row = await env.DB.prepare(
          "SELECT value FROM system_flags WHERE key = ?",
        )
          .bind(`holdonly:${project}`)
          .first<{ value: string }>();
        return flagTruthy(row?.value);
      } catch {
        return false;
      }
    },
    async isCloseHoldOnly(project: string): Promise<boolean> {
      // Per-key check (mirrors isHoldOnly): applyCloseAutoTune dedups on whether THIS project's CLOSE breaker is
      // already engaged, so it reads the per-project `closehold:` key, not the global-or-project read above.
      try {
        const row = await env.DB.prepare(
          "SELECT value FROM system_flags WHERE key = ?",
        )
          .bind(`closehold:${project}`)
          .first<{ value: string }>();
        return flagTruthy(row?.value);
      } catch {
        return false;
      }
    },
    async setFlag(key: string, on: boolean): Promise<void> {
      if (on) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)",
        )
          .bind(key)
          .run();
      } else {
        await env.DB.prepare("DELETE FROM system_flags WHERE key = ?")
          .bind(key)
          .run();
      }
    },
    async flagSetAt(key: string): Promise<string | null> {
      try {
        const row = await env.DB.prepare(
          "SELECT updated_at FROM system_flags WHERE key = ?",
        )
          .bind(key)
          .first<{ updated_at: string }>();
        return row?.updated_at ?? null;
      } catch {
        return null;
      }
    },
  };
}

// ── review_audit append (the canonical eval/parity store) ───────────────────────────────────────────────────

/** The target_id the gate-decision writer (parity-wire.ts) stamps — `project#pr`. The pr_outcome/reversal rows
 *  MUST use the same key so computeGateEval can join a prediction to its realized outcome. */
function reviewAuditTargetId(repoFullName: string, pullNumber: number): string {
  return `${repoFullName.slice(0, 200)}#${pullNumber}`;
}

/** Append one row to review_audit. Best-effort — a write failure is swallowed (telemetry must not break the
 *  webhook). `decision` is the realized merge/close for a pr_outcome row; null for a reversal marker row. */
async function appendReviewAudit(
  env: Env,
  input: {
    project: string;
    targetId: string;
    eventType: string;
    decision?: string | null;
    summary?: string | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, ?, ?, 'gittensory-native', NULL, ?, ?)`,
    )
      .bind(
        `${input.eventType}:${input.targetId}:${nowIso()}:${Math.random().toString(36).slice(2, 8)}`,
        input.project,
        input.targetId,
        input.eventType,
        input.decision ?? null,
        input.summary ?? null,
        nowIso(),
      )
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "review_audit_record_error",
        auditEventType: input.eventType,
        project: input.project,
        message: errorMessage(error).slice(0, 160),
      }),
    );
  }
}

// ── 1) pr_outcome — realized ground truth (merged vs closed) ─────────────────────────────────────────────────

/**
 * Record a PR's REALIZED outcome (the eval's answer key) when it closes. Mirrors reviewbot runtime.ts (~164):
 * on a `pull_request` `closed` webhook, write a `pr_outcome` row capturing merged-vs-closed so computeGateEval
 * can score the gate's prediction against what the human actually did — even on repos where the bot didn't act.
 *
 * Writes to BOTH the canonical eval store (review_audit, with the decision column the eval reads) AND the
 * general audit ledger (audit_events, via recordAuditEvent, per the GAP-4 task). Best-effort throughout. A
 * non-closed action, or a payload with no PR number, records nothing.
 */
/** Enrich a disposition notification with the AI's reasoning: the latest recorded gate verdict (the reasonCode
 *  summary on the most recent `gate_decision` row for this PR). Falls back to the plain disposition reason when
 *  no verdict is recorded or the read fails. Exported for tests. */
export async function resolveDispositionReason(
  env: Env,
  targetId: string,
  fallback: string,
): Promise<string> {
  try {
    const verdict = await env.DB.prepare(
      "SELECT summary FROM review_audit WHERE target_id = ? AND event_type = 'gate_decision' AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
      .bind(targetId)
      .first<{ summary: string | null }>();
    return verdict?.summary || fallback;
  } catch {
    return fallback;
  }
}

export async function recordPrOutcome(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<void> {
  if (eventName !== "pull_request" || payload.action !== "closed") return;
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;
  if (!pr?.number || !repoFullName) return;

  const merged = Boolean(pr.merged_at);
  const senderLogin = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.user?.login ?? "").toLowerCase();
  const botWasActor = payload.sender?.type === "Bot";
  // A PR author can close their own unmerged PR without maintainer approval. Those self-closes are not
  // authoritative ground truth for the repository's merge/close decision and must not feed the precision
  // circuit-breaker; otherwise contributors can poison merge precision by closing their own mergeable PRs.
  // Merges remain trusted because GitHub requires merge permission, and maintainer/bot closes are not self-closes.
  if (
    !merged &&
    !botWasActor &&
    senderLogin &&
    authorLogin &&
    senderLogin === authorLogin
  )
    return;

  const decision = merged ? "merged" : "closed";
  // Observability (#reviews-dashboard): realized human outcome (merged vs closed) for the Grafana panel + as the
  // ground truth to compare against the engine's gate verdicts.
  incr("gittensory_pr_outcomes_total", { outcome: decision });
  const targetId = reviewAuditTargetId(repoFullName, pr.number);

  await appendReviewAudit(env, {
    project: repoFullName.slice(0, 200),
    targetId,
    eventType: "pr_outcome",
    decision,
  });
  await recordAuditEvent(env, {
    eventType: "pr_outcome",
    actor: payload.sender?.login ?? null,
    targetKey: targetId,
    outcome: "completed",
    detail: decision,
    metadata: { repoFullName, pullNumber: pr.number, merged, botWasActor },
  }).catch((error) =>
    console.warn(
      JSON.stringify({
        event: "pr_outcome_audit_error",
        message: errorMessage(error).slice(0, 160),
      }),
    ),
  );

  // #4283: proactively refresh THIS PR author's decision pack now (within seconds) instead of waiting up to
  // DECISION_PACK_MAX_AGE_MS (~6h) for the next passive staleness read at serving time. Best-effort + non-blocking —
  // an enqueue failure must never affect pr_outcome recording (mirrors the caller's own `.catch` at processors.ts).
  // A non-authoritative self-close already returned above, so this only fires on real outcomes; skip an empty login.
  // The 6h passive check stays as the fallback ceiling for authors this proactive path misses.
  if (authorLogin) {
    await tryEnqueueDecisionPackRebuild(env, authorLogin).catch((error) =>
      console.warn(
        JSON.stringify({
          event: "pr_outcome_decision_pack_rebuild_error",
          message: errorMessage(error).slice(0, 160),
        }),
      ),
    );
  }

  // Discord/Slack action notifications are emitted by the action executor, which knows the exact bot action that
  // was attempted and can audit the delivery. This outcome recorder only stores realized ground truth. Emitting
  // another webhook from the GitHub `pull_request.closed` event duplicated bot-action notifications and could
  // route through stale/global self-host webhook config.
}

// ── 2) reversals — a human undid a bot action ────────────────────────────────────────────────────────────────

/** Was the last GITTENSORY action on this PR a CLOSE? Reads the agent-action audit ledger (audit_events,
 *  eventType `agent.action.<class>`, written by buildAgentActionAudit) — the most-recent SUCCESSFUL action for
 *  this target. A reopen of a bot-CLOSED PR is the high-value "human disagreed with the close" reversal signal.
 *  Fail-safe: a read error → false (record nothing rather than a false reversal). */
async function lastBotActionWasClose(
  env: Env,
  targetKey: string,
): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      // The executor records performed and dry-run actions as outcome 'completed', with the real mode only in
      // metadata. Exclude dry-run shadows so a "would close" cannot masquerade as an actual bot close.
      // 'success' is only a legacy value. (#audit-reversal-reopened)
      `SELECT event_type FROM audit_events
         WHERE target_key = ? AND event_type LIKE 'agent.action.%' AND outcome IN ('success', 'completed')
           AND COALESCE(json_extract(metadata_json, '$.mode'), 'live') <> 'dry_run'
         ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(targetKey)
      .first<{ event_type: string }>();
    return row?.event_type === "agent.action.close";
  } catch {
    return false;
  }
}

/** True when our canonical ledger recorded PR #N as MERGED (a `pr_outcome`/decision=merged review_audit row —
 *  the same store ops.ts reads for reversalRate). A "Reverts #N" PR only marks a reversal of an outcome WE
 *  observed; otherwise an arbitrary "Reverts #N" in a contributor's merged PR would forge a reversal signal.
 *  Fail-safe: a read error → false (record nothing rather than a false reversal). (#audit-3.2) */
async function wasMergeRecorded(env: Env, targetId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS hit FROM review_audit WHERE target_id = ? AND event_type = 'pr_outcome' AND decision = 'merged' LIMIT 1`,
    )
      .bind(targetId)
      .first<{ hit: number }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Record a REVERSAL — a human overriding a gittensory auto-action — into the eval/audit stores (the
 * ground-truth accuracy signal). Mirrors reviewbot recordReversalSignals (runtime.ts ~157/274):
 *   • REOPEN of a bot-CLOSED PR by a CONTRIBUTOR → `reversal_reopened` (the high-value case). Reopens by the
 *     repo OWNER (administrative re-queue) or by a BOT are NOT contributor disputes and are skipped, so the
 *     reversal signal isn't inflated.
 *   • a merged "Reverts #N" PR (a bot-MERGED PR a human reverted) → `reversal_reverted` against PR #N.
 *
 * Writes to BOTH review_audit (what ops.ts joins for reversalRate/calibration) and audit_events (the general
 * ledger). Best-effort + independent of the review path. A non-reversal event records nothing.
 */
export async function recordReversalSignals(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<void> {
  if (eventName !== "pull_request") return;
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;
  if (!pr?.number || !repoFullName) return;
  const project = repoFullName.slice(0, 200);

  // A bot-CLOSED PR REOPENED by a contributor — the genuine "human disagreed with this close" signal.
  if (payload.action === "reopened") {
    const ownerLogin = (repoFullName.split("/")[0] || "").toLowerCase();
    const senderLogin = (payload.sender?.login || "").toLowerCase();
    const senderIsOwner =
      !!ownerLogin && !!senderLogin && ownerLogin === senderLogin;
    const senderIsBot = payload.sender?.type === "Bot";
    if (senderIsBot || senderIsOwner) return; // administrative / bot reopen — not a contributor dispute
    const targetId = reviewAuditTargetId(repoFullName, pr.number);
    if (!(await lastBotActionWasClose(env, targetId))) return; // only a bot-CLOSED PR reopening is a reversal
    await appendReviewAudit(env, {
      project,
      targetId,
      eventType: "reversal_reopened",
      summary: `Bot-closed PR #${pr.number} reopened by a contributor.`,
    });
    await recordAuditEvent(env, {
      eventType: "reversal_reopened",
      actor: payload.sender?.login ?? null,
      targetKey: targetId,
      outcome: "completed",
      detail: `Bot-closed PR #${pr.number} reopened by a contributor.`,
      metadata: { repoFullName, pullNumber: pr.number },
    }).catch(() => undefined);
    return;
  }

  // A merged "Reverts #N" PR — a bot-MERGED PR that a human reverted.
  if (payload.action === "closed" && Boolean(pr.merged_at)) {
    const reverted = parseRevertedPrNumber(pr.body);
    if (!reverted) return;
    const revertedTargetKey = reviewAuditTargetId(repoFullName, reverted);
    // Corroborate before recording: only count a reversal of a merge WE actually observed (#audit-3.2). Without
    // this, a contributor's legitimately-merged PR whose body cites an arbitrary "Reverts #N" would stamp a
    // spurious reversal against PR #N, inflating reversalRate/calibration. Mirrors reviewbot's bot-merged guard.
    if (!(await wasMergeRecorded(env, revertedTargetKey))) return;
    // The reverted PR (#N) had a recorded pr_outcome=merged; the reversal_reverted row marks that merge as later
    // undone so reversalRate/calibration reflect it. (Auto-revert — opening a revert PR — is a separate, larger
    // feature and intentionally NOT wired here; this records the human-driven revert signal.)
    await appendReviewAudit(env, {
      project,
      targetId: revertedTargetKey,
      eventType: "reversal_reverted",
      summary: `Merged PR #${reverted} was reverted by #${pr.number}.`,
    });
    await recordAuditEvent(env, {
      eventType: "reversal_reverted",
      actor: payload.sender?.login ?? null,
      targetKey: revertedTargetKey,
      outcome: "completed",
      detail: `Merged PR #${reverted} was reverted by #${pr.number}.`,
      metadata: {
        repoFullName,
        revertedPullNumber: reverted,
        revertPullNumber: pr.number,
      },
    }).catch(() => undefined);
  }
}

// ── 3) precision circuit-breaker tick (cron) ─────────────────────────────────────────────────────────────────

/** How far back computeGateEval looks for the prediction-vs-outcome confusion matrix. */
const BREAKER_EVAL_WINDOW_DAYS = 90;

/**
 * One precision-circuit-breaker tick, run on the scheduled (selftune) cron. Reads the gate-eval confusion
 * matrix over gittensory's OWN recorded pr_outcome/gate_decision rows -- SCOPED to `source: 'gittensory-native'`
 * (#autoclear-deadlock / stale-source): review_audit can also carry historical `gate_decision` rows from the
 * pre-convergence reviewbot engine (source='reviewbot'), which stopped running once a repo converged and so
 * never grows. Reading across ALL sources (the pre-fix behavior) let a permanently-frozen legacy prediction set
 * dominate a project's measured precision forever, with no way for it to ever reflect the LIVE gate's actual
 * behavior -- exactly the scenario that leaves a breaker stuck: precision can never "recover" against data that
 * never changes. Scoping to the live source makes the loop honest: it judges (and can only re-engage on) what
 * THIS instance's own gate has actually predicted. It then engages/clears BOTH breakers:
 *   • MERGE: ENGAGES holdonly:<project> for any repo whose merge precision dropped below the floor over a real
 *     sample (applyAutoTune) — the would-MERGE → HOLD downgrade then kicks in on the next merge path; AUTO-CLEARS
 *     an auto-engaged breaker once its cooldown elapsed AND precision recovered (maybeAutoClearHoldOnly).
 *   • CLOSE (symmetric twin): ENGAGES closehold:<project> for any repo whose CLOSE precision dropped below the
 *     floor (applyCloseAutoTune) — the would-CLOSE → HOLD downgrade kicks in next close path; AUTO-CLEARS the
 *     same way (maybeAutoClearCloseHoldOnly).
 * Strictly TIGHTENING-only in both directions: it only ever makes the system MORE cautious; a human clears a
 * breaker that should be cleared early. FAILS SAFE — a thrown error is logged and swallowed (tuning must never
 * break the cron). With no pr_outcome history the eval reads neutral → nothing engages → byte-identical. The
 * close breaker is INERT until selftune is enabled AND close-outcome data is present, exactly like its merge twin.
 */
// #2352: the flag-scope suffix that makes a miner-originated project's breaker flags (holdonly:<project>:miner
// / closehold:<project>:miner) DISTINCT from the same project's human/mixed-population flags. Every downstream
// primitive that keys on `project` -- applyAutoTune/applyCloseAutoTune/maybeAutoClear* (auto-tune.ts),
// createFlagStore, listEngagedProjectScopes -- is already fully generic over that opaque string, so re-keying
// a report's rows with this suffix is the ENTIRE mechanism; none of those primitives needed to change.
const MINER_BREAKER_SCOPE_SUFFIX = ":miner";

function minerBreakerScope(project: string): string {
  return `${project}${MINER_BREAKER_SCOPE_SUFFIX}`;
}

/** Run the full engage + auto-clear sequence for one {@link GateEvalReport} (either the plain project-keyed
 *  report or a miner-rescoped one). `eventPrefix` namespaces the emitted log events (`""` for the existing
 *  human/mixed pass, `"miner_"` for the #2352 miner-scoped pass) so an operator can tell which population
 *  triggered a given line. `engagedHoldonly`/`engagedClosehold` are this SAME scope's already-engaged flags
 *  (the caller pre-splits {@link listEngagedProjectScopes}'s result by scope) -- passing the WRONG scope's
 *  engaged list here would auto-clear a flag using the other population's precision, which is exactly the
 *  cross-scope leak #2352 exists to prevent. */
async function runBreakerPassForReport(
  flags: FlagStore,
  report: GateEvalReport,
  engagedHoldonly: readonly string[],
  engagedClosehold: readonly string[],
  nowMs: number,
  eventPrefix: string,
): Promise<void> {
  const engaged = await applyAutoTune(flags, report);
  for (const action of engaged) {
    console.error(
      JSON.stringify({
        level: "error",
        event: `${eventPrefix}breaker_engaged`,
        project: action.project,
        mergePrecision: action.mergePrecision,
        decided: action.decided,
        floor: AUTOTUNE_MERGE_PRECISION_FLOOR,
      }),
    );
  }
  // CLOSE-side breaker: engage closehold for any repo whose close precision dropped below the floor.
  const closeEngaged = await applyCloseAutoTune(flags, report);
  for (const action of closeEngaged) {
    console.error(
      JSON.stringify({
        level: "error",
        event: `${eventPrefix}close_breaker_engaged`,
        project: action.project,
        closePrecision: action.closePrecision,
        decided: action.decided,
        floor: AUTOTUNE_CLOSE_PRECISION_FLOOR,
      }),
    );
  }
  // OBSERVABILITY: a single summary line of the engaged close-hold backlog so a human can see, at a glance,
  // how many (and which) repos are currently holding would-closes for review. Only emitted when ≥1 engaged.
  if (closeEngaged.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        event: `${eventPrefix}closehold_backlog`,
        count: closeEngaged.length,
        projects: closeEngaged.map((a) => a.project),
      }),
    );
  }
  // Auto-clear any auto-engaged breaker (merge AND close) that has cooled down + recovered. Candidates are the
  // UNION of report.rows (projects with a fresh decided sample) and every project currently holding a
  // per-project flag IN THIS SCOPE (#autoclear-deadlock) — a project whose breaker is suppressing 100% of its
  // merges/closes stops producing new decided samples for THAT action class and can drop out of report.rows
  // entirely, which would otherwise strand its flag engaged forever regardless of how long the cooldown has
  // elapsed.
  const mergeClearCandidates = new Set([...report.rows.map((row) => row.project), ...engagedHoldonly]);
  const closeClearCandidates = new Set([...report.rows.map((row) => row.project), ...engagedClosehold]);
  for (const project of mergeClearCandidates) {
    if (await maybeAutoClearHoldOnly(flags, report, project, nowMs)) {
      console.log(JSON.stringify({ event: `${eventPrefix}breaker_auto_cleared`, project }));
    }
  }
  for (const project of closeClearCandidates) {
    if (await maybeAutoClearCloseHoldOnly(flags, report, project, nowMs)) {
      console.log(JSON.stringify({ event: `${eventPrefix}close_breaker_auto_cleared`, project }));
    }
  }
}

export async function runSelfTuneBreaker(env: Env): Promise<void> {
  try {
    const nowMs = Date.now();
    const report: GateEvalReport = await computeGateEval(env, {
      days: BREAKER_EVAL_WINDOW_DAYS,
      nowMs,
      source: GITTENSORY_NATIVE_SOURCE,
    });
    // #2352: a SEPARATE, miner-scoped pass so a miner fleet's own self-review accuracy trips the SAME breaker
    // independently of the maintainer's overall (mixed) accuracy. Re-keying every row's `project` with the
    // `:miner` suffix (see MINER_BREAKER_SCOPE_SUFFIX's own doc comment) is what makes every downstream
    // primitive naturally produce a DISTINCT flag, with zero changes to auto-tune.ts itself.
    const minerReportRaw = await computeGateEval(env, {
      days: BREAKER_EVAL_WINDOW_DAYS,
      nowMs,
      source: GITTENSORY_NATIVE_SOURCE,
      minerOnly: true,
    });
    const minerReport: GateEvalReport = {
      hasSignal: minerReportRaw.hasSignal,
      rows: minerReportRaw.rows.map((row) => ({ ...row, project: minerBreakerScope(row.project) })),
    };

    const flags = createFlagStore(env);
    const engagedScopes = await listEngagedProjectScopes(env);
    const isMinerScope = (project: string): boolean => project.endsWith(MINER_BREAKER_SCOPE_SUFFIX);

    await runBreakerPassForReport(
      flags,
      report,
      engagedScopes.holdonly.filter((project) => !isMinerScope(project)),
      engagedScopes.closehold.filter((project) => !isMinerScope(project)),
      nowMs,
      "",
    );
    await runBreakerPassForReport(
      flags,
      minerReport,
      engagedScopes.holdonly.filter(isMinerScope),
      engagedScopes.closehold.filter(isMinerScope),
      nowMs,
      "miner_",
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "breaker_tick_error",
        message: errorMessage(error).slice(0, 200),
      }),
    );
  }
}
