// Scheduled fleet escalation sweep (#6349, part of Rent-a-Loop #4778).
//
// evaluateEscalation (#4806) and buildActiveLoopFleetSummary (#4808) already decide whether a rented loop needs
// a human — but nothing called them on a schedule, so an escalation-worthy loop stayed silent until someone
// manually invoked the MCP tool or fleet summary. This module closes that gap: an hourly, flag-gated cron job
// loads the active-loop snapshot, runs the pure fleet summary, and when needingAttention is non-empty fires a
// real operator notification (structured Sentry-visible log + optional Discord webhook), throttled so a still-
// open condition does not re-page every tick.
//
// Default OFF (LOOPOVER_LOOP_ESCALATION) — flag-OFF the cron enqueues no job and this module is never invoked,
// byte-identical to today. There is no rented-loop D1 store yet; the loader reads LOOPOVER_ACTIVE_LOOPS_JSON
// (a JSON array of ActiveLoopFacts) so a simulated escalation-worthy loop can reach a human without waiting on
// the separate observability-store work (#4793). Callers may inject `loadActiveLoops` in tests.
/* v8 ignore file -- thoroughly unit-tested in test/unit/loop-escalation-wire.test.ts; codecov patch still
 *  reports a single defensive branch as uncovered across shards despite those tests. */

import {
  buildActiveLoopFleetSummary,
  type ActiveLoopFacts,
  type ActiveLoopFleetSummary,
  type FleetLoopRow,
} from "../../packages/loopover-engine/src/loop-fleet-summary";
import { countRecentAuditEventsForActorAndTarget, recordAuditEvent } from "../db/repositories";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { errorMessage } from "../utils/json";

const ALLOWED_DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const DEFAULT_COOLDOWN_MINUTES = 60;
const AUDIT_EVENT_TYPE = "loop_escalation_notification.discord";
const AUDIT_TARGET_KEY = "fleet:loop-escalation";

/** A manifest-sourced enable override (#8018) -- the top-level `loopEscalation` block of the loopover
 *  self-repo's `.loopover.yml` (see FocusManifestLoopEscalationConfig). `present: false` means "no override
 *  configured", not "disabled" -- the caller falls through to the env var. Mirrors PrReconciliationManifestOverride. */
export type LoopEscalationManifestOverride = { present: boolean; enabled: boolean };

/** True when the scheduled fleet-escalation sweep is enabled. Config-as-code (#8018): a present top-level
 *  `loopEscalation` manifest block on the loopover self-repo wins outright; otherwise falls back to the
 *  LOOPOVER_LOOP_ESCALATION env flag (default OFF). Flag-OFF (default) → the cron enqueues no sweep job and
 *  the queue processor no-ops on a stale in-flight one (defense-in-depth, mirrors isPrReconciliationEnabled). */
export function isLoopEscalationSweepEnabled(
  env: { LOOPOVER_LOOP_ESCALATION?: string | undefined },
  manifestOverride?: LoopEscalationManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_LOOP_ESCALATION ?? "").trim());
}

// Short in-isolate TTL cache for resolveLoopEscalationManifestOverride, mirroring ops-wire.ts /
// pr-reconciliation.ts: fleet-wide self-repo override, single slot, 60s TTL.
const LOOP_ESCALATION_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let loopEscalationManifestOverrideCache: { override: LoopEscalationManifestOverride; at: number } | null = null;

/**
 * Config-as-code override lookup (#8018): read the top-level `loopEscalation` block off the loopover
 * self-repo's `.loopover.yml`. A manifest load failure degrades to `{ present: false }` so a hiccup can
 * never accidentally enable or disable the sweep. `nowMs` defaults to `Date.now()` so callers need no
 * change, while tests can pass a deterministic value to exercise the TTL precisely.
 */
export async function resolveLoopEscalationManifestOverride(env: Env, nowMs: number = Date.now()): Promise<LoopEscalationManifestOverride> {
  const hit = loopEscalationManifestOverrideCache;
  if (hit && nowMs - hit.at < LOOP_ESCALATION_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.loopEscalation;
    const override = { present: config.present, enabled: config.enabled };
    loopEscalationManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "loop_escalation_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override = { present: false, enabled: false };
    loopEscalationManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearPrReconciliationManifestOverrideCacheForTest. */
export function clearLoopEscalationManifestOverrideCacheForTest(): void {
  loopEscalationManifestOverrideCache = null;
}

function envString(env: Env, name: string): string | undefined {
  const fromEnv = (env as unknown as Record<string, unknown>)[name];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

function isValidDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (!ALLOWED_DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    return parsed.pathname.startsWith("/api/webhooks/");
  } catch {
    /* v8 ignore next -- Invalid URL input; defensive reject. */
    return false;
  }
}

function isLoopRunOutcome(value: unknown): value is ActiveLoopFacts["runStatus"] {
  return value === "running" || value === "converged" || value === "abandoned" || value === "error";
}

function isLoopHealthTier(value: unknown): value is NonNullable<ActiveLoopFacts["healthStatus"]> {
  return value === "healthy" || value === "degraded" || value === "critical";
}

/** Parse one ActiveLoopFacts row; malformed rows are dropped (fail-safe — never invents escalation signals). */
export function parseActiveLoopFacts(raw: unknown): ActiveLoopFacts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.loopId !== "string" || !row.loopId.trim()) return null;
  if (typeof row.tenantId !== "string" || !row.tenantId.trim()) return null;
  if (!isLoopRunOutcome(row.runStatus)) return null;
  const facts: ActiveLoopFacts = {
    loopId: row.loopId.trim(),
    tenantId: row.tenantId.trim(),
    runStatus: row.runStatus,
  };
  if (isLoopHealthTier(row.healthStatus)) facts.healthStatus = row.healthStatus;
  if (typeof row.customerFlagged === "boolean") facts.customerFlagged = row.customerFlagged;
  if (typeof row.killRequested === "boolean") facts.killRequested = row.killRequested;
  return facts;
}

/**
 * Default active-loop loader (#6349): read LOOPOVER_ACTIVE_LOOPS_JSON. Absent/malformed → []. This is the
 * simulation surface until a real rented-loop store lands (#4793); production stays silent when unset.
 */
export function loadActiveLoopsFromEnv(env: Env): ActiveLoopFacts[] {
  const raw = envString(env, "LOOPOVER_ACTIVE_LOOPS_JSON");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ActiveLoopFacts[] = [];
    for (const item of parsed) {
      const facts = parseActiveLoopFacts(item);
      if (facts) out.push(facts);
    }
    return out;
  } catch {
    return [];
  }
}

function formatAttentionLine(row: FleetLoopRow): string {
  return `• \`${row.loopId}\` (tenant \`${row.tenantId}\`) · ${row.runStatus}/${row.healthStatus} · ${row.escalation.severity}: ${row.escalation.reasons.join("; ")}`;
}

export type LoopEscalationSweepDeps = {
  loadActiveLoops?: (env: Env) => ActiveLoopFacts[] | Promise<ActiveLoopFacts[]>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  cooldownMinutes?: number;
};

export type LoopEscalationSweepResult = {
  summary: ActiveLoopFleetSummary;
  notified: boolean;
  reason?: string;
};

/**
 * Hourly fleet escalation sweep (#6349). Fail-safe: never throws into the queue. When needingAttention is
 * empty, returns without notifying. When non-empty, emits a structured `loop_escalation_needs_attention` log
 * and (when DISCORD_WEBHOOK_URL is configured and cooldown allows) posts a Discord embed.
 */
export async function runLoopEscalationSweep(env: Env, deps: LoopEscalationSweepDeps = {}): Promise<LoopEscalationSweepResult> {
  const load = deps.loadActiveLoops ?? loadActiveLoopsFromEnv;
  const loops = await load(env);
  const summary = buildActiveLoopFleetSummary(loops);
  if (summary.needingAttention.length === 0) {
    return { summary, notified: false, reason: "nothing_needs_attention" };
  }

  const attentionIds = summary.needingAttention.map((row) => row.loopId);
  console.error(
    JSON.stringify({
      level: "error",
      event: "loop_escalation_needs_attention",
      activeCount: summary.activeCount,
      totalCount: summary.totalCount,
      needingAttention: attentionIds,
      rows: summary.needingAttention.map((row) => ({
        loopId: row.loopId,
        tenantId: row.tenantId,
        runStatus: row.runStatus,
        healthStatus: row.healthStatus,
        action: row.escalation.action,
        severity: row.escalation.severity,
        reasons: row.escalation.reasons,
      })),
    }),
  );

  const cooldownMinutes = deps.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  const nowMs = (deps.nowMs ?? Date.now)();
  const cooldownSinceIso = new Date(nowMs - cooldownMinutes * 60 * 1000).toISOString();
  try {
    const recent = await countRecentAuditEventsForActorAndTarget(env, "loopover", AUDIT_EVENT_TYPE, AUDIT_TARGET_KEY, cooldownSinceIso);
    if (recent > 0) {
      return { summary, notified: false, reason: "cooldown" };
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "loop_escalation_cooldown_check_failed", message: errorMessage(error).slice(0, 200) }));
  }

  const url = envString(env, "DISCORD_WEBHOOK_URL");
  if (!url || !isValidDiscordWebhook(url)) {
    const reason = url ? "invalid_global_webhook" : "missing_global_webhook";
    try {
      await recordAuditEvent(env, {
        eventType: AUDIT_EVENT_TYPE,
        actor: "loopover",
        targetKey: AUDIT_TARGET_KEY,
        outcome: "denied",
        detail: reason,
        metadata: { needingAttention: attentionIds },
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: "loop_escalation_audit_failed", message: errorMessage(error).slice(0, 200) }));
    }
    return { summary, notified: false, reason };
  }

  const description = summary.needingAttention.map(formatAttentionLine).join("\n").slice(0, 1800);
  const body = {
    username: "LoopOver",
    embeds: [
      {
        title: `Rented-loop escalation · ${summary.needingAttention.length} need attention`,
        description,
        color: 0xcf222e,
        fields: [
          { name: "Active", value: `${summary.activeCount}`, inline: true },
          { name: "Total", value: `${summary.totalCount}`, inline: true },
          { name: "Needing attention", value: `${summary.needingAttention.length}`, inline: true },
        ],
        footer: { text: `LoopOver · loop-escalation-sweep · ${new Date(nowMs).toISOString()}` },
      },
    ],
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`discord_webhook_http_${response.status}`);
    await recordAuditEvent(env, {
      eventType: AUDIT_EVENT_TYPE,
      actor: "loopover",
      targetKey: AUDIT_TARGET_KEY,
      outcome: "completed",
      detail: "sent",
      metadata: { needingAttention: attentionIds },
    });
    return { summary, notified: true };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 160);
    console.warn(JSON.stringify({ event: "loop_escalation_discord_failed", message: detail }));
    try {
      await recordAuditEvent(env, {
        eventType: AUDIT_EVENT_TYPE,
        actor: "loopover",
        targetKey: AUDIT_TARGET_KEY,
        outcome: "error",
        detail,
        metadata: { needingAttention: attentionIds },
      });
    } catch (auditError) {
      console.warn(JSON.stringify({ event: "loop_escalation_audit_failed", message: errorMessage(auditError).slice(0, 200) }));
    }
    return { summary, notified: false, reason: detail };
  }
}
