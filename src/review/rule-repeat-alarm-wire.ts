// ORB wiring for #7983's same-rule repeat alarm. Records a #7982 rule-fired signal for each gate blocker code
// on every gate block, then checks whether that SAME (repo, blocker code) pair has now fired against enough
// DISTINCT PRs within a short window to be a "something is systematically broken" signal — independent of
// whether any of those blocks has since been confirmed or reversed by a human (unlike the precision-over-time
// circuit breaker in auto-tune.ts, which needs a real, DECIDED sample of >= AUTOTUNE_MIN_DECIDED and however
// long that takes to accumulate). This is exactly the gap the 2026-07-21/22 metagraphed incident exposed: 4
// distinct PRs mis-closed by the same rule within ~3 hours, far faster than any ground-truth-based breaker
// could ever react.
//
// DETECTION + ALERT ONLY (#7983's own stated boundary, mirroring src/orb/analytics.ts's gamingPatternFlags
// precedent: "Detection only — never an automatic action"). This module never holds, closes, or otherwise
// changes any gate/disposition decision — it only records a signal and, once, surfaces a structured alert.
//
// Alert channel: NOT notify-discord.ts/notify-slack (that's a per-REPO, community-facing channel for PR
// action notifications — the wrong audience for "an ORB rule may be systematically broken," which is an
// OPERATOR concern that can span any repo the instance reviews). Uses the same console.error(JSON.stringify(
// {level:"error",...})) idiom src/review/ops-wire.ts's runOpsAlerts already uses for its own operator-anomaly
// detection — forwarded to Sentry by selfhost/sentry.ts's forwardStructuredLogToSentry, the actually-live
// operator-facing channel for exactly this class of "detected an anomaly, not a caught exception" alert.

import { evaluateRuleRepeatAlarm, type SignalStore } from "@loopover/engine";

import { hasRecentAuditEvent, recordAuditEvent } from "../db/repositories";
import { nowIso } from "../utils/json";
import { createSignalStore } from "./signal-tracking-wire";

/** How far back to look for repeat fires. Matches #7983's own "e.g. 1-24h, tunable" proposal — chosen at the
 *  wide end so a slow-burn (not just a fast-burst) repeat still gets caught. */
const RULE_REPEAT_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Distinct-target count that trips the alarm. #7983's own proposal ("e.g. >= 3 within 24h") and its own
 *  validation bar ("should have alerted after the 2nd or 3rd occurrence" against the real incident replay). */
export const RULE_REPEAT_ALARM_THRESHOLD = 3;
/** Once triggered, don't re-alert for the SAME (repo, code) pair more often than this — an already-known,
 *  ongoing incident re-alerting on every subsequent PR would be noise, not new information. Shorter than
 *  {@link RULE_REPEAT_ALARM_WINDOW_MS} so a genuinely NEW burst (a different day, a fix that regressed again)
 *  still re-alerts well before the detection window itself would naturally reset. */
const RULE_REPEAT_ALARM_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Repo-scoped rule id (#7983 wants the alarm keyed by "(deployment/repo-or-cohort, rule code)", not a bare
 *  code across the whole fleet — a code that's simply common everywhere must not look like one repo's rule
 *  going haywire). Reuses the same signal-tracking `ruleId` seam #7982 already defined; the repo scope is
 *  folded directly into the id rather than needing a second dimension on {@link SignalStore}. */
function repeatAlarmRuleId(repoFullName: string, blockerCode: string): string {
  return `${repoFullName}:${blockerCode}`;
}

function alertAuditEventType(ruleId: string): string {
  return `rule_repeat_alarm:${ruleId}`;
}

async function checkAndAlertRuleRepeat(
  env: Env,
  store: SignalStore,
  ruleId: string,
  blockerCode: string,
  repoFullName: string,
): Promise<void> {
  const history = await store.queryRuleHistory(ruleId, Date.now() - RULE_REPEAT_ALARM_WINDOW_MS);
  const verdict = evaluateRuleRepeatAlarm(ruleId, history.fired, RULE_REPEAT_ALARM_THRESHOLD);
  if (!verdict.triggered) return;
  const alertEventType = alertAuditEventType(ruleId);
  const alreadyAlerted = await hasRecentAuditEvent(
    env,
    "loopover",
    alertEventType,
    new Date(Date.now() - RULE_REPEAT_ALARM_ALERT_COOLDOWN_MS).toISOString(),
  );
  if (alreadyAlerted) return;
  console.error(
    JSON.stringify({
      level: "error",
      event: "same_rule_repeat_alarm",
      ev: ruleId,
      repo: repoFullName,
      blockerCode,
      distinctTargetCount: verdict.affectedTargets.length,
      threshold: verdict.threshold,
      affectedTargets: verdict.affectedTargets,
      at: nowIso(),
    }),
  );
  await recordAuditEvent(env, {
    eventType: alertEventType,
    actor: "loopover",
    targetKey: ruleId,
    outcome: "completed",
    detail: `same-rule repeat alarm: ${blockerCode} fired against ${verdict.affectedTargets.length} distinct PR(s) in ${repoFullName} within ${RULE_REPEAT_ALARM_WINDOW_MS / (60 * 60 * 1000)}h`,
    metadata: { repoFullName, blockerCode, affectedTargets: verdict.affectedTargets },
  }).catch(() => undefined);
}

/**
 * Records a #7982 rule-fired signal for every blocker code on a gate block, then runs the #7983 repeat-alarm
 * check for each. Best-effort throughout (a failure anywhere in this path is swallowed) — this is a pure
 * measurement/alerting side channel and must never affect, delay, or fail the gate decision that produced the
 * blocker codes it's recording.
 */
export async function recordGateBlockersAndCheckRepeatAlarm(
  env: Env,
  args: { repoFullName: string; pullNumber: number; blockerCodes: readonly string[]; occurredAt?: string },
): Promise<void> {
  if (args.blockerCodes.length === 0) return;
  // createSignalStore is pure object construction (no I/O), so it never throws — no try/catch needed here.
  // recordRuleFired below already swallows its own write failures internally (signal-tracking-wire.ts), so it
  // never rejects either; only queryRuleHistory (inside checkAndAlertRuleRepeat) can genuinely reject, which
  // this loop's own .catch below covers.
  const store = createSignalStore(env);
  const occurredAt = args.occurredAt ?? nowIso();
  const targetKey = `${args.repoFullName}#${args.pullNumber}`;
  for (const blockerCode of new Set(args.blockerCodes)) {
    const ruleId = repeatAlarmRuleId(args.repoFullName, blockerCode);
    await store.recordRuleFired({ ruleId, targetKey, outcome: "block", occurredAt });
    await checkAndAlertRuleRepeat(env, store, ruleId, blockerCode, args.repoFullName).catch(() => undefined);
  }
}
