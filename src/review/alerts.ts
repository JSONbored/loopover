// Anomaly alerting (reviewbot→gittensory convergence — ADDITIVE, NATIVE port of reviewbot
// src/core/alerts.ts). On each cron tick, snapshot agent health and push a THROTTLED Discord alert when
// something drifts — a manual-rate spike, stuck/failed targets, a DLQ spike, calibration drift, disputed
// closes, or a config invariant violation — so drift is HEARD ABOUT instead of polled for.
//
// SELF-CONTAINED: every type + helper this module needs is defined HERE. No imports from reviewbot. The
// logic is byte-faithful to the reviewbot source; the only deltas are mechanical guards for gittensory's
// stricter tsconfig (noUncheckedIndexedAccess / exactOptionalPropertyTypes), which do not change behavior.
//
// STORAGE: gittensory has no platform/access adapter — `Env` is a global ambient interface with `DB`. The
// `storage(env) => env.DB` helper below mirrors the other native ports (unified-comment-bridge etc.).
//
// HEALTH/CALIBRATION INPUTS: computing the D1 health/calibration snapshots is the runtime gate's job
// (see src/review/ops.ts in this same port batch). `runAnomalyAlerts` takes them as INJECTED deps so this
// module stays decoupled from the gate runtime — the host wires its own `computeAgentHealth` /
// `computeCalibration` (or the ported native ones) at call time.

// ── Inlined minimal types (ported from reviewbot src/core/{ops,types}.ts) ────────────────────────

/** A permanently-failed review, with the PR + reason so the alert is actionable (not just a count). */
export interface FailedTarget {
  number: number;
  repo: string;
  verdict: string | null;
  lastError: string | null;
}

/** A bot auto-action a human overrode (revert of a bot-merge / reopen of a bot-close), with the PR. */
export interface ReversedTarget {
  number: number;
  repo: string;
  status: string;
  eventType: string;
}

/** Per-agent health snapshot from review_targets + config invariants. Shared by /status and alerting.
 *  (Ported shape from reviewbot src/core/ops.ts AgentHealth — every field load-bearing here is kept.) */
export interface AgentHealth {
  byStatus: Record<string, number>;
  byVerdict: Record<string, number>;
  /** Count of terminal decisions (merged/closed/commented/manual/error) — the manualRate denominator. */
  terminalCount: number;
  nonTerminal: number;
  /** Fraction of terminal decisions punted to a human. */
  manualRate: number;
  stuckRetryable: number;
  /** Permanently-failed (dead-lettered or attempt-exhausted) reviews in the recent window. */
  failed: number;
  /** Dead-letter-queue events (event_type='dead_lettered') in the recent window — reviews the queue gave
   *  up on. A spike means a systemic problem (rate-limit storm, AI-quota exhaustion) dropped a batch. */
  dlqCount: number;
  dlqTargets?: FailedTarget[];
  /** Count of auto-actions a human overrode in the recent window (revert of a bot-merge, reopen of a
   *  bot-close that the gate did NOT subsequently merge). */
  reversals: number;
  /** reversals / (merged + closed) — the ground-truth accuracy signal. 0 when nothing auto-acted. */
  reversalRate: number;
  /** The specific recent failed / reversed PRs, for an actionable alert (capped). Absent on hand-built
   *  health objects (e.g. tests) — render defensively. */
  failedTargets?: FailedTarget[];
  reversedTargets?: ReversedTarget[];
  configIssues: string[];
  /** Kill-switch state: true when this agent's autonomous writes are frozen. Optional for hand-built objects. */
  frozen?: boolean;
  /** Accuracy circuit-breaker: true when auto-merge is disabled for this project. Optional for hand-built objects. */
  holdOnly?: boolean;
}

/** Confidence-vs-outcome calibration (ported shape from reviewbot src/core/ops.ts Calibration). */
export interface Calibration {
  currentFloor: number;
  mergedCount: number;
  revertedCount: number;
  keptAvgConfidence: number | null;
  revertedMaxConfidence: number | null;
  /** A suggested confidenceFloor (only when it would be HIGHER than current); null = no change needed. */
  recommendedFloor: number | null;
  note: string;
  /** Per-reasonCode close distribution + how many of each a human REOPENED and the gate did NOT re-merge. */
  closesByReason: Array<{ reasonCode: string; closes: number; disputed: number }>;
  disputedCloseCount: number;
}

/** The minimal agent-config shape the alerter reads — slug/name for the embed, the discord webhook source,
 *  and the discordNotify feature flag. (Subset of reviewbot's AgentConfig.) */
export interface AlertAgentConfig {
  slug: string;
  name?: string;
  features: { discordNotify?: boolean };
  secrets: { discordWebhook?: string };
  discordWebhookUrl?: string;
}

// ── Inlined helpers (byte-faithful from reviewbot src/core/{crypto,util,notify,db}.ts) ───────────

/** Storage seam: gittensory's `Env` is a global ambient interface with `DB`. */
function storage(env: Env): D1Database {
  return env.DB;
}

const ALLOWED_DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

/** Discord webhook URL validation (reviewbot src/core/notify.ts). */
function isValidDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_DISCORD_HOSTS.has(parsed.hostname.toLowerCase()) &&
      parsed.pathname.startsWith("/api/webhooks/")
    );
  } catch {
    return false;
  }
}

/** Read a per-agent secret/var from the worker env by name (reviewbot src/core/util.ts). */
function readSecret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

/** Prefixed random id (reviewbot src/core/crypto.ts). */
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

const sha256Encoder = new TextEncoder();

/** SHA-256 hex (reviewbot src/core/crypto.ts). */
async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", sha256Encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Rows affected by a D1 write (reviewbot src/core/db.ts). */
function runChanges(result: unknown): number {
  return (result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
}

// ── Thresholds (byte-faithful from reviewbot src/core/alerts.ts) ─────────────────────────────────

const MANUAL_RATE_THRESHOLD = 0.6;
const MIN_TERMINAL_FOR_RATE = 10; // don't cry "manual-rate spike" off a handful of decisions
const STUCK_THRESHOLD = 5;
// DLQ should be ~0 in normal operation — even a few dropped reviews is a systemic signal (rate-limit/AI-quota
// storm). Alert low so we hear about it within a cron tick, not days later via manual audit.
const DLQ_ALERT_THRESHOLD = 3;

const MAX_LISTED = 8; // keep the embed readable; note the remainder

/** A markdown PR link Discord renders in an embed description. */
function prLink(t: { number: number; repo: string }): string {
  return `[#${t.number}](https://github.com/${t.repo}/pull/${t.number})`;
}

/** ": #a, #b, #c (+N more)" for an anomaly line — empty when no detail (e.g. a hand-built health obj). */
function listSuffix<T extends { number: number; repo: string }>(items: T[] | undefined, render: (t: T) => string): string {
  if (!items?.length) return "";
  const shown = items.slice(0, MAX_LISTED).map(render).join(", ");
  const more = items.length > MAX_LISTED ? ` (+${items.length - MAX_LISTED} more)` : "";
  return `: ${shown}${more}`;
}

/** Human-readable anomalies in a health snapshot (empty list = healthy). Lines NAME the specific PRs so
 *  the maintainer can act without going to query D1 — and so testing artifacts (e.g. proof-reopens) are
 *  identifiable at a glance rather than reading as mystery failures. */
export function detectAnomalies(h: AgentHealth, calibration?: Calibration): string[] {
  const out: string[] = [];
  // Autonomous circuit-breaker engaged: auto-merge was disabled after merge precision dropped.
  if (h.holdOnly) out.push("auto-merge DISABLED by the accuracy circuit-breaker (merge precision dropped) — would-merges are holding for review; investigate, then clear the holdonly flag.");
  if (h.configIssues.length > 0) out.push(`config invariant violation(s): ${h.configIssues.join("; ")}`);
  // CALIBRATION DRIFT: the recommender found a human-reverted auto-merge whose confidence cleared the
  // current floor — the ground-truth signal that the floor is too low.
  if (calibration?.recommendedFloor != null) {
    const maxRev = calibration.revertedMaxConfidence != null ? `${Math.round(calibration.revertedMaxConfidence * 100)}%` : "?";
    out.push(`calibration drift: ${calibration.revertedCount} auto-merge(s) were human-reverted, the highest at ${maxRev} — above the ${Math.round(calibration.currentFloor * 100)}% floor. Consider raising confidenceFloor to ${calibration.recommendedFloor}.`);
  }
  // FALSE-CLOSE signal: bot-closes a human REOPENED and did NOT let the gate re-merge — the human
  // disagreed with the close. Broken down by reasonCode so a specific over-closing gate is identifiable.
  if (calibration && calibration.disputedCloseCount > 0) {
    const top = calibration.closesByReason
      .filter((r) => r.disputed > 0)
      .sort((a, b) => b.disputed - a.disputed)
      .slice(0, 3)
      .map((r) => `${r.reasonCode} (${r.disputed}/${r.closes})`)
      .join(", ");
    out.push(`disputed closes: ${calibration.disputedCloseCount} bot-close(s) reopened and not re-merged — by reason: ${top}. Review these close-gates for false-closes.`);
  }
  // DLQ SPIKE: the queue gave up on reviews (event_type='dead_lettered'). A spike = a systemic storm
  // (rate-limit / AI-quota exhaustion) silently dropped a batch. NAME the dropped PRs so they can be re-queued.
  if ((h.dlqCount ?? 0) >= DLQ_ALERT_THRESHOLD) {
    const list = listSuffix(h.dlqTargets, (t) => `${prLink(t)}${t.lastError ? ` · ${t.lastError}` : ""}`);
    out.push(`⚠️ ${h.dlqCount} review(s) DEAD-LETTERED in the window — the queue gave up (likely a rate-limit / AI-quota storm). These were dropped and need a re-queue${list}`);
  }
  if (h.failed > 0) {
    const list = listSuffix(h.failedTargets, (t) => `${prLink(t)} (${t.verdict ?? "no verdict"}${t.lastError ? ` · ${t.lastError}` : ""})`);
    out.push(`${h.failed} review(s) permanently failed — attempt-exhausted/dead-lettered${list}`);
  }
  if (h.terminalCount >= MIN_TERMINAL_FOR_RATE && h.manualRate >= MANUAL_RATE_THRESHOLD) {
    out.push(`manual-rate ${Math.round(h.manualRate * 100)}% over ${h.terminalCount} decisions`);
  }
  if (h.stuckRetryable >= STUCK_THRESHOLD) out.push(`${h.stuckRetryable} target(s) stuck in error_retryable`);
  if (h.reversals > 0) {
    const list = listSuffix(h.reversedTargets, (t) => prLink(t));
    out.push(`${h.reversals} auto-action(s) reverted/reopened by humans in the last 7d (reversal-rate ${Math.round(h.reversalRate * 100)}%)${list}`);
  }
  return out;
}

function resolveWebhook(env: Env, config: AlertAgentConfig): string {
  if (config.secrets.discordWebhook) return readSecret(env, config.secrets.discordWebhook);
  return config.discordWebhookUrl ?? "";
}

/** Injected snapshot computation — the host wires its own (or the native ops port's) health/calibration. */
export interface AnomalyAlertDeps {
  computeAgentHealth: (env: Env, config: AlertAgentConfig) => Promise<AgentHealth>;
  computeCalibration: (env: Env, config: AlertAgentConfig) => Promise<Calibration>;
}

/** Snapshot health and Discord-alert any anomalies, at most once per condition-set per hour. */
export async function runAnomalyAlerts(env: Env, config: AlertAgentConfig, deps: AnomalyAlertDeps): Promise<void> {
  if (!config.features.discordNotify) return;
  const webhookUrl = resolveWebhook(env, config);
  if (!webhookUrl || !isValidDiscordWebhook(webhookUrl)) return;

  // Gate the EXPENSIVE health snapshot behind a per-agent, per-hour claim, so the every-minute cron
  // computes it ~hourly (matching the alert throttle) instead of 1440×/day. The first tick of the hour
  // computes + maybe alerts; the other 59 short-circuit here before touching D1.
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const checkClaim = await storage(env).prepare(
    `INSERT INTO notification_deliveries (id, project, target_id, notification_key, status)
     VALUES (?, ?, '__healthcheck__', ?, 'sent')
     ON CONFLICT(project, target_id, notification_key) DO NOTHING`,
  )
    .bind(newId("hc"), config.slug, await sha256Hex(`healthcheck:${config.slug}:${hourBucket}`))
    .run();
  if (runChanges(checkClaim) === 0) return; // already snapshotted this agent this hour

  // Both behind the same hourly claim: health + calibration (the drift signal).
  const [health, calibration] = await Promise.all([deps.computeAgentHealth(env, config), deps.computeCalibration(env, config)]);
  const anomalies = detectAnomalies(health, calibration);
  if (anomalies.length === 0) return;

  // Throttle: claim a per-(condition-set, hour) key so a repeated condition alerts at most hourly.
  const key = await sha256Hex(`anomaly:${anomalies.join("|")}:${hourBucket}`);
  const claim = await storage(env).prepare(
    `INSERT INTO notification_deliveries (id, project, target_id, notification_key, status)
     VALUES (?, ?, '__anomaly__', ?, 'sent')
     ON CONFLICT(project, target_id, notification_key) DO NOTHING`,
  )
    .bind(newId("anm"), config.slug, key)
    .run();
  if (runChanges(claim) === 0) return; // already alerted this hour for this condition-set

  const body = {
    username: config.name ?? config.slug,
    embeds: [
      {
        title: `⚠️ ${config.slug}: health anomaly`,
        color: 0xbf8700,
        description: anomalies.map((a) => `• ${a}`).join("\n").slice(0, 1800),
        footer: { text: `${config.slug} · ${hourBucket}Z` },
      },
    ],
  };
  try {
    await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.log(JSON.stringify({ event: "anomaly_alert_error", project: config.slug, message: String(error).slice(0, 200) }));
  }
}
