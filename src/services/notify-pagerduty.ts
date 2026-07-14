import { countRecentAuditEventsForActorAndTarget, recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";
import { meetsSeverityThreshold, resolveSeverityThreshold, type LoopoverSeverity } from "./severity-threshold";

// PagerDuty Events API v2 (https://developer.pagerduty.com/docs/events-api-v2/overview/). Experimental,
// default-OFF (LOOPOVER_ENABLE_PAGERDUTY) — a self-host operator opts in per #4937's paging epic.
// Mirrors notify-discord.ts's per-repo routing precedence exactly: PAGERDUTY_REPO_ROUTING_KEYS (a JSON map,
// {repoFullName: routingKey}) takes priority over the single global PAGERDUTY_ROUTING_KEY fallback. Neither
// var is declared on the strict Env type (same asymmetry as DISCORD_REPO_WEBHOOKS) — a free-form per-repo
// JSON map isn't worth a formal interface field; the global fallbacks are, and are declared in env.d.ts.
//
// ALERT FATIGUE: paging is the loudest, most disruptive channel loopover has — unlike a Discord post or a
// Sentry issue, it can wake someone up. Two independent controls keep it from crying wolf, on top of
// PagerDuty's own `dedup_key` coalescing (which prevents duplicate *incidents* but not duplicate *pages* for
// a still-open one):
//   • MIN SEVERITY — a repo only pages once its worst detected condition meets PAGERDUTY_MIN_SEVERITY (global,
//     default `error`) or its PAGERDUTY_REPO_MIN_SEVERITY override. Routine calibration nudges never page by
//     default; only active-incident-grade anomalies do.
//   • COOLDOWN — a repeat trigger for the SAME `dedup_key` within PAGERDUTY_COOLDOWN_MINUTES (global, default
//     60) or its PAGERDUTY_REPO_COOLDOWN_MINUTES override is suppressed, so a still-ongoing condition re-checked
//     every cron tick doesn't re-page every tick.

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
// PagerDuty routing/integration keys are 32 lowercase hex characters.
const ROUTING_KEY_RE = /^[a-f0-9]{32}$/i;
const DEFAULT_MIN_SEVERITY: PagerDutySeverity = "error";
const DEFAULT_COOLDOWN_MINUTES = 60;

/** True when the experimental PagerDuty integration is enabled. Flag-OFF (default) → every export below is a
 *  no-op. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as isOpsEnabled/isSafetyEnabled). */
export function isPagerDutyEnabled(env: {
  LOOPOVER_ENABLE_PAGERDUTY?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_ENABLE_PAGERDUTY ?? "").trim());
}

function envString(env: Env, name: string): string | undefined {
  const fromEnv = (env as unknown as Record<string, unknown>)[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  /* v8 ignore next 2 -- process.env is the self-host Node fallback; Worker/D1 tests pass values on Env. */
  const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromProcess = processEnv?.[name];
  return typeof fromProcess === "string" && fromProcess.trim().length > 0 ? fromProcess.trim() : undefined;
}

/** Parse a `{repoFullName: value}` JSON map off `envName`, lower-casing repo keys. Malformed/absent → `{}`. */
function repoJsonMap(env: Env, envName: string): Record<string, unknown> {
  const raw = envString(env, envName);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const [repo, value] of Object.entries(parsed)) {
      out[repo.toLowerCase()] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export type PagerDutyRoutingResolution =
  | { status: "configured"; routingKey: string; source: "repo_map" | "global" }
  | { status: "disabled"; reason: "flag_off" | "missing_repo_key" | "invalid_repo_key" | "missing_global_key" | "invalid_global_key" };

/** Resolve the PagerDuty routing key for `repoFullName`: per-repo map entry, else the global fallback, else
 *  disabled. Mirrors {@link resolveDiscordWebhook}'s exact precedence and shape. */
export function resolvePagerDutyRoutingKey(env: Env, repoFullName: string): PagerDutyRoutingResolution {
  if (
    !isPagerDutyEnabled(
      env as unknown as { LOOPOVER_ENABLE_PAGERDUTY?: string | undefined },
    )
  ) {
    return { status: "disabled", reason: "flag_off" };
  }
  const repoKey = repoFullName.toLowerCase();
  const map = repoJsonMap(env, "PAGERDUTY_REPO_ROUTING_KEYS");
  if (Object.prototype.hasOwnProperty.call(map, repoKey)) {
    const mapped = map[repoKey];
    const routingKey = typeof mapped === "string" ? mapped.trim() : "";
    return routingKey && ROUTING_KEY_RE.test(routingKey)
      ? { status: "configured", routingKey, source: "repo_map" }
      : { status: "disabled", reason: "invalid_repo_key" };
  }
  const fallback = envString(env, "PAGERDUTY_ROUTING_KEY");
  return fallback && ROUTING_KEY_RE.test(fallback)
    ? { status: "configured", routingKey: fallback, source: "global" }
    : { status: "disabled", reason: fallback ? "invalid_global_key" : "missing_global_key" };
}

/** @deprecated alias of {@link LoopoverSeverity} -- kept so existing imports (ops-wire.ts's
 *  classifyAnomalySeverity/worstAnomaly) don't need a rename. Shares the codebase's one severity-threshold
 *  concept (#5119) instead of a PagerDuty-only copy. */
export type PagerDutySeverity = LoopoverSeverity;

/** Resolve the minimum severity that pages for `repoFullName`: per-repo map entry, else the global override,
 *  else {@link DEFAULT_MIN_SEVERITY} — the quietest safe default, so an operator who never touches these vars
 *  still only gets paged for active-incident-grade conditions, never routine calibration nudges. Delegates to
 *  the shared {@link resolveSeverityThreshold} resolver (#5119) so PagerDuty and Sentry share one
 *  severity-threshold concept, not two parallel ones. */
export function resolvePagerDutyMinSeverity(env: Env, repoFullName: string): PagerDutySeverity {
  return resolveSeverityThreshold(env, repoFullName, "PAGERDUTY_MIN_SEVERITY", "PAGERDUTY_REPO_MIN_SEVERITY", DEFAULT_MIN_SEVERITY);
}

/** Coerce a JSON-map value or raw env string to a positive minute count; anything else (absent, zero,
 *  negative, non-numeric) is "not configured", not "zero cooldown". */
function coercePositiveMinutes(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Resolve the repeat-page cooldown (minutes) for `repoFullName`: per-repo map entry, else the global
 *  override, else {@link DEFAULT_COOLDOWN_MINUTES}. */
export function resolvePagerDutyCooldownMinutes(env: Env, repoFullName: string): number {
  const map = repoJsonMap(env, "PAGERDUTY_REPO_COOLDOWN_MINUTES");
  const repoMinutes = coercePositiveMinutes(map[repoFullName.toLowerCase()]);
  if (repoMinutes != null) return repoMinutes;
  const globalMinutes = coercePositiveMinutes(envString(env, "PAGERDUTY_COOLDOWN_MINUTES"));
  return globalMinutes ?? DEFAULT_COOLDOWN_MINUTES;
}

async function auditPagerDutyNotification(
  env: Env,
  params: { repoFullName: string; dedupKey: string },
  outcome: "completed" | "denied" | "error",
  detail: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "external_notification.pagerduty",
    actor: "loopover",
    targetKey: params.dedupKey,
    outcome,
    detail,
    metadata: { repoFullName: params.repoFullName, dedupKey: params.dedupKey, ...metadata },
  }).catch((error) => {
    console.warn(JSON.stringify({ event: "pagerduty_notify_audit_failed", repo: params.repoFullName, message: errorMessage(error).slice(0, 120) }));
  });
}

/** Trigger (or update, via PagerDuty's own `dedup_key` semantics — a repeat call with the SAME dedupKey
 *  updates the existing incident instead of opening a new one) a PagerDuty incident for `repoFullName`.
 *  Best-effort: never throws — a paging failure must never affect the caller's own work. No-op when the
 *  flag is off, no routing key resolves for this repo, `severity` doesn't meet the repo's configured
 *  {@link resolvePagerDutyMinSeverity} floor, or a page for this `dedupKey` already fired within the repo's
 *  {@link resolvePagerDutyCooldownMinutes} window. An explicitly-misconfigured key (present but invalid) and
 *  a below-threshold/cooldown-suppressed page are audited as `denied` so they're discoverable, while the
 *  common "not opted in" case stays silent (no audit-log noise for every repo that never configured
 *  PagerDuty). */
export async function triggerPagerDutyIncident(
  env: Env,
  params: {
    repoFullName: string;
    summary: string;
    severity: PagerDutySeverity;
    dedupKey: string;
    customDetails?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const resolution = resolvePagerDutyRoutingKey(env, params.repoFullName);
  if (resolution.status === "disabled") {
    if (resolution.reason !== "flag_off") {
      await auditPagerDutyNotification(env, { repoFullName: params.repoFullName, dedupKey: params.dedupKey }, "denied", resolution.reason);
    }
    return;
  }

  const minSeverity = resolvePagerDutyMinSeverity(env, params.repoFullName);
  if (!meetsSeverityThreshold(params.severity, minSeverity)) {
    await auditPagerDutyNotification(env, { repoFullName: params.repoFullName, dedupKey: params.dedupKey }, "denied", "below_min_severity", {
      severity: params.severity,
      minSeverity,
    });
    return;
  }

  const cooldownMinutes = resolvePagerDutyCooldownMinutes(env, params.repoFullName);
  const cooldownSinceIso = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
  // Also count the pre-rebrand "gittensory" actor: a page recorded under the OLD actor value just before this
  // rebrand deployed must still suppress a duplicate page after it, for as long as the configured cooldown
  // window can reach back across the deploy boundary. Querying both actors costs one extra indexed count and
  // removes the whole risk category rather than requiring a precisely-timed follow-up cleanup.
  const [recentPagesNewActor, recentPagesLegacyActor] = await Promise.all([
    countRecentAuditEventsForActorAndTarget(env, "loopover", "external_notification.pagerduty", params.dedupKey, cooldownSinceIso),
    countRecentAuditEventsForActorAndTarget(env, "gittensory", "external_notification.pagerduty", params.dedupKey, cooldownSinceIso),
  ]);
  const recentPages = recentPagesNewActor + recentPagesLegacyActor;
  if (recentPages > 0) {
    await auditPagerDutyNotification(env, { repoFullName: params.repoFullName, dedupKey: params.dedupKey }, "denied", "cooldown_active", { cooldownMinutes });
    return;
  }

  try {
    const response = await fetch(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: resolution.routingKey,
        event_action: "trigger",
        dedup_key: params.dedupKey,
        payload: {
          summary: params.summary.slice(0, 1024),
          source: "loopover",
          severity: params.severity,
          timestamp: new Date().toISOString(),
          component: params.repoFullName,
          custom_details: params.customDetails,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`pagerduty_events_http_${response.status}`);
    await auditPagerDutyNotification(env, { repoFullName: params.repoFullName, dedupKey: params.dedupKey }, "completed", "triggered", { source: resolution.source });
  } catch (error) {
    const message = errorMessage(error);
    console.warn(JSON.stringify({ event: "pagerduty_trigger_failed", repo: params.repoFullName, message: message.slice(0, 200) }));
    await auditPagerDutyNotification(env, { repoFullName: params.repoFullName, dedupKey: params.dedupKey }, "error", message.slice(0, 280));
  }
}
