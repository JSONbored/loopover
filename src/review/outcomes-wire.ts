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
import type { GitHubWebhookPayload } from "../types";
import { errorMessage, nowIso } from "../utils/json";
import { applyAutoTune, AUTOTUNE_MERGE_PRECISION_FLOOR, type FlagStore, type GateEvalReport, maybeAutoClearHoldOnly } from "./auto-tune";
import { computeGateEval } from "./parity";

/** PURE: parse the PR number an "Reverts #N / Reverts owner/repo#N" body refers to (GitHub's revert PRs).
 *  Mirrors reviewbot runtime.ts parseRevertedPrNumber. Returns undefined when the body isn't a revert. */
export function parseRevertedPrNumber(body: string | null | undefined): number | undefined {
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
export async function isHoldOnly(env: Env, project: string): Promise<boolean> {
  try {
    const res = await env.DB.prepare("SELECT key, value FROM system_flags").all<{ key: string; value: string }>();
    const set = new Set<string>();
    for (const r of res.results ?? []) if (flagTruthy(r.value)) set.add(r.key);
    return set.has("holdonly:global") || set.has(`holdonly:${project}`);
  } catch (error) {
    console.warn(JSON.stringify({ ev: "flags_read_error", message: errorMessage(error).slice(0, 120) }));
    return false; // fail-OPEN: a DB blip must never silently change the merge path
  }
}

/** A live FlagStore over system_flags for the circuit-breaker (applyAutoTune / maybeAutoClearHoldOnly). */
export function createFlagStore(env: Env): FlagStore {
  return {
    async isHoldOnly(project: string): Promise<boolean> {
      // Per-key check (NOT the global-or-project read above): applyAutoTune dedups on whether THIS project's
      // breaker is already engaged, so it must read the per-project key, not fold in the global one.
      try {
        const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(`holdonly:${project}`).first<{ value: string }>();
        return flagTruthy(row?.value);
      } catch {
        return false;
      }
    },
    async setFlag(key: string, on: boolean): Promise<void> {
      if (on) {
        await env.DB.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)").bind(key).run();
      } else {
        await env.DB.prepare("DELETE FROM system_flags WHERE key = ?").bind(key).run();
      }
    },
    async flagSetAt(key: string): Promise<string | null> {
      try {
        const row = await env.DB.prepare("SELECT updated_at FROM system_flags WHERE key = ?").bind(key).first<{ updated_at: string }>();
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
  input: { project: string; targetId: string; eventType: string; decision?: string | null; summary?: string | null },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, ?, ?, 'gittensory-native', NULL, ?, ?)`,
    )
      .bind(`${input.eventType}:${input.targetId}:${nowIso()}:${Math.random().toString(36).slice(2, 8)}`, input.project, input.targetId, input.eventType, input.decision ?? null, input.summary ?? null, nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ ev: "review_audit_record_error", event: input.eventType, project: input.project, message: errorMessage(error).slice(0, 160) }));
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
export async function recordPrOutcome(env: Env, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  if (eventName !== "pull_request" || payload.action !== "closed") return;
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;
  if (!pr?.number || !repoFullName) return;

  const merged = Boolean(pr.merged_at);
  const decision = merged ? "merged" : "closed";
  const targetId = reviewAuditTargetId(repoFullName, pr.number);
  // Whether GITTENSORY itself was the actor that resolved this PR — for the metadata only (the bot's own
  // close/merge action was already recorded as an agent.action.* audit row; this just annotates the outcome).
  const botWasActor = payload.sender?.type === "Bot";

  await appendReviewAudit(env, { project: repoFullName.slice(0, 200), targetId, eventType: "pr_outcome", decision });
  await recordAuditEvent(env, {
    eventType: "pr_outcome",
    actor: payload.sender?.login ?? null,
    targetKey: targetId,
    outcome: "completed",
    detail: decision,
    metadata: { repoFullName, pullNumber: pr.number, merged, botWasActor },
  }).catch((error) => console.warn(JSON.stringify({ ev: "pr_outcome_audit_error", message: errorMessage(error).slice(0, 160) })));
}

// ── 2) reversals — a human undid a bot action ────────────────────────────────────────────────────────────────

/** Was the last GITTENSORY action on this PR a CLOSE? Reads the agent-action audit ledger (audit_events,
 *  eventType `agent.action.<class>`, written by buildAgentActionAudit) — the most-recent SUCCESSFUL action for
 *  this target. A reopen of a bot-CLOSED PR is the high-value "human disagreed with the close" reversal signal.
 *  Fail-safe: a read error → false (record nothing rather than a false reversal). */
async function lastBotActionWasClose(env: Env, targetKey: string): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT event_type FROM audit_events
         WHERE target_key = ? AND event_type LIKE 'agent.action.%' AND outcome = 'success'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(targetKey)
      .first<{ event_type: string }>();
    return row?.event_type === "agent.action.close";
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
export async function recordReversalSignals(env: Env, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  if (eventName !== "pull_request") return;
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;
  if (!pr?.number || !repoFullName) return;
  const project = repoFullName.slice(0, 200);

  // A bot-CLOSED PR REOPENED by a contributor — the genuine "human disagreed with this close" signal.
  if (payload.action === "reopened") {
    const ownerLogin = (repoFullName.split("/")[0] || "").toLowerCase();
    const senderLogin = (payload.sender?.login || "").toLowerCase();
    const senderIsOwner = !!ownerLogin && !!senderLogin && ownerLogin === senderLogin;
    const senderIsBot = payload.sender?.type === "Bot";
    if (senderIsBot || senderIsOwner) return; // administrative / bot reopen — not a contributor dispute
    const targetId = reviewAuditTargetId(repoFullName, pr.number);
    if (!(await lastBotActionWasClose(env, targetId))) return; // only a bot-CLOSED PR reopening is a reversal
    await appendReviewAudit(env, { project, targetId, eventType: "reversal_reopened", summary: `Bot-closed PR #${pr.number} reopened by a contributor.` });
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
    // The reverted PR (#N) had a recorded pr_outcome=merged only if it merged; the reversal_reverted row marks
    // that merge as later undone so reversalRate/calibration reflect it. (Auto-revert — opening a revert PR — is
    // a separate, larger feature and intentionally NOT wired here; this records the human-driven revert signal.)
    await appendReviewAudit(env, { project, targetId: revertedTargetKey, eventType: "reversal_reverted", summary: `Merged PR #${reverted} was reverted by #${pr.number}.` });
    await recordAuditEvent(env, {
      eventType: "reversal_reverted",
      actor: payload.sender?.login ?? null,
      targetKey: revertedTargetKey,
      outcome: "completed",
      detail: `Merged PR #${reverted} was reverted by #${pr.number}.`,
      metadata: { repoFullName, revertedPullNumber: reverted, revertPullNumber: pr.number },
    }).catch(() => undefined);
  }
}

// ── 3) precision circuit-breaker tick (cron) ─────────────────────────────────────────────────────────────────

/** How far back computeGateEval looks for the prediction-vs-outcome confusion matrix. */
const BREAKER_EVAL_WINDOW_DAYS = 90;

/**
 * One precision-circuit-breaker tick, run on the scheduled (selftune) cron. Reads the gate-eval confusion
 * matrix over gittensory's OWN recorded pr_outcome/gate_decision rows, then:
 *   • ENGAGES the breaker (holdonly:<project>) for any repo whose merge precision dropped below the floor over
 *     a real sample (applyAutoTune) — the would-MERGE → HOLD downgrade then kicks in on the next merge path.
 *   • AUTO-CLEARS an auto-engaged breaker once its cooldown elapsed AND precision recovered (maybeAutoClearHoldOnly).
 * Strictly TIGHTENING-only: it only ever makes the system MORE cautious; a human clears a breaker that should
 * be cleared early. FAILS SAFE — a thrown error is logged and swallowed (tuning must never break the cron). With
 * no pr_outcome history the eval reads neutral → nothing engages → byte-identical.
 */
export async function runSelfTuneBreaker(env: Env): Promise<void> {
  try {
    const nowMs = Date.now();
    const report: GateEvalReport = await computeGateEval(env, { days: BREAKER_EVAL_WINDOW_DAYS, nowMs });
    const flags = createFlagStore(env);
    const engaged = await applyAutoTune(flags, report);
    for (const action of engaged) {
      console.warn(JSON.stringify({ ev: "breaker_engaged", project: action.project, mergePrecision: action.mergePrecision, decided: action.decided, floor: AUTOTUNE_MERGE_PRECISION_FLOOR }));
    }
    // Auto-clear any auto-engaged breaker that has cooled down + recovered (one per repo present in the report).
    for (const row of report.rows) {
      if (await maybeAutoClearHoldOnly(flags, report, row.project, nowMs)) {
        console.log(JSON.stringify({ ev: "breaker_auto_cleared", project: row.project }));
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({ ev: "breaker_tick_error", message: errorMessage(error).slice(0, 200) }));
  }
}
