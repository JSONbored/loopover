import { recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";
import type { RecapReport } from "../types";

// Per-repo Discord notifications (reviewbot parity). Each repo notifies its OWN channel on a terminal action —
// merged / closed / changes-requested(manual) — so the operator sees what the bot did, like the old Reviewbott
// embeds. Best-effort: a notify failure NEVER affects the gate/action (wrapped + swallowed by the caller).
// RC1 already dedups at the action level (the planner won't re-post an unchanged verdict), so this fires once
// per outcome per PR without a separate notification ledger.

const ALLOWED_DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

function isValidDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_DISCORD_HOSTS.has(parsed.hostname.toLowerCase()) && parsed.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

// Map the first-party repos to legacy operator-set webhook SECRET names. A repo with a specific mapping must never
// fall back to the global webhook: falling back posts repo A's disposition into repo B's channel. Generic
// self-hosters should prefer DISCORD_REPO_WEBHOOKS for per-repo routing, or DISCORD_WEBHOOK_URL for one shared
// channel across unmapped repos.
const WEBHOOK_SECRET_BY_REPO: Record<string, string> = {
  "jsonbored/gittensory": "LOOPOVER_DISCORD_WEBHOOK",
  "jsonbored/metagraphed": "METAGRAPHED_DISCORD_WEBHOOK",
  "jsonbored/awesome-claude": "AWESOME_DISCORD_WEBHOOK",
};

function envString(env: Env, name: string): string | undefined {
  const fromEnv = (env as unknown as Record<string, unknown>)[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  /* v8 ignore next 2 -- process.env is the self-host Node fallback; Worker/D1 tests pass values on Env. */
  const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromProcess = processEnv?.[name];
  return typeof fromProcess === "string" && fromProcess.trim().length > 0 ? fromProcess.trim() : undefined;
}

function repoWebhookMap(env: Env): Record<string, unknown> {
  const raw = envString(env, "DISCORD_REPO_WEBHOOKS");
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

export type DiscordWebhookResolution =
  | { status: "configured"; url: string; source: "repo_map" | "legacy_repo_secret" | "global" }
  | { status: "disabled"; reason: "missing_repo_webhook" | "invalid_repo_webhook" | "missing_global_webhook" | "invalid_global_webhook" };

export function resolveDiscordWebhook(env: Env, repoFullName: string): DiscordWebhookResolution {
  const repoKey = repoFullName.toLowerCase();
  const map = repoWebhookMap(env);
  if (Object.prototype.hasOwnProperty.call(map, repoKey)) {
    const mapped = map[repoKey];
    const url = typeof mapped === "string" ? mapped.trim() : "";
    return url && isValidDiscordWebhook(url) ? { status: "configured", url, source: "repo_map" } : { status: "disabled", reason: "invalid_repo_webhook" };
  }

  const name = WEBHOOK_SECRET_BY_REPO[repoKey];
  if (name) {
    const mapped = envString(env, name);
    return mapped && isValidDiscordWebhook(mapped) ? { status: "configured", url: mapped, source: "legacy_repo_secret" } : { status: "disabled", reason: mapped ? "invalid_repo_webhook" : "missing_repo_webhook" };
  }

  // Modular self-host default: ANY repo not in the built-in map falls back to a single DISCORD_WEBHOOK_URL, so a
  // self-host operator gets per-action notifications for THEIR repos without editing this source map. Unset →
  // undefined → no-notify, byte-identical to today.
  const fallback = envString(env, "DISCORD_WEBHOOK_URL");
  return fallback && isValidDiscordWebhook(fallback) ? { status: "configured", url: fallback, source: "global" } : { status: "disabled", reason: fallback ? "invalid_global_webhook" : "missing_global_webhook" };
}

async function postWebhook(url: string, init: RequestInit, provider: "discord" | "slack"): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${provider}_webhook_http_${response.status}`);
}

export type NotifyOutcome = "merged" | "closed" | "manual";

const OUTCOME_META: Record<NotifyOutcome, { word: string; color: number }> = {
  merged: { word: "merged", color: 0x2ea043 },
  closed: { word: "closed", color: 0xcf222e },
  manual: { word: "manual review", color: 0xbf8700 },
};

async function auditExternalNotification(
  env: Env,
  params: { repoFullName: string; pullNumber: number; outcome: NotifyOutcome },
  provider: "discord" | "slack",
  outcome: "completed" | "denied" | "error",
  detail: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: `external_notification.${provider}`,
    actor: "loopover",
    targetKey: `${params.repoFullName}#${params.pullNumber}`,
    outcome,
    detail,
    metadata: { repoFullName: params.repoFullName, pullNumber: params.pullNumber, actionOutcome: params.outcome, ...metadata },
  }).catch((error) => {
    console.warn(JSON.stringify({ event: `${provider}_notify_audit_failed`, repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
  });
}

/** Post a per-action Discord embed (merged/closed/manual) to the repo's channel. Best-effort: never throws. */
export async function notifyActionToDiscord(
  env: Env,
  params: { repoFullName: string; pullNumber: number; outcome: NotifyOutcome; summary: string; submitter?: string | null | undefined },
): Promise<void> {
  const resolved = resolveDiscordWebhook(env, params.repoFullName);
  if (resolved.status !== "configured") {
    await auditExternalNotification(env, params, "discord", "denied", resolved.reason);
    return;
  }
  const meta = OUTCOME_META[params.outcome];
  const body = {
    username: "LoopOver",
    embeds: [
      {
        title: `${params.repoFullName}#${params.pullNumber} · ${meta.word}`,
        url: `https://github.com/${params.repoFullName}/pull/${params.pullNumber}`,
        description: (params.summary || meta.word).slice(0, 1800),
        color: meta.color,
        fields: [
          { name: "Outcome", value: `\`${params.outcome}\``, inline: true },
          { name: "PR", value: `#${params.pullNumber}`, inline: true },
          ...(params.submitter ? [{ name: "Submitter", value: `@${params.submitter}`, inline: true }] : []),
        ],
        footer: { text: `LoopOver · ${params.repoFullName}` },
      },
    ],
  };
  try {
    await postWebhook(resolved.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }, "discord");
    await auditExternalNotification(env, params, "discord", "completed", "sent", { source: resolved.source });
  } catch (error) {
    console.warn(JSON.stringify({ event: "discord_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
    await auditExternalNotification(env, params, "discord", "error", errorMessage(error).slice(0, 160), { source: resolved.source });
  }
}

/**
 * Deliver a maintainer recap digest (#2245, the Discord channel of #1963) as an embed. Unlike the per-repo
 * `ReviewRecap` sender {@link sendReviewRecapToDiscord} (review-recap.ts) — which resolves a per-repo channel via
 * {@link resolveDiscordWebhook}, exactly like {@link notifyActionToDiscord} — a maintainer `RecapReport` is ONE
 * operator-level digest spanning many repos (`report.repos`), so there is no single repo to route by: it posts to
 * the flat global `DISCORD_WEBHOOK_URL`. Best-effort and observable, mirroring `sendReviewRecapToDiscord`: an
 * unset/invalid webhook or a send failure is recorded to the audit ledger (`maintainer_recap_notification.discord`)
 * and returned as `{ sent: false, reason }` but never thrown, so a Discord outage never breaks the recap job.
 * When {@link runMaintainerRecap} passes a {@link formatMaintainerRecap} body, the embed description uses that
 * redacted markdown instead of raw {@link RecapReport.summary} lines.
 */
export async function deliverRecapToDiscord(
  env: Env,
  report: RecapReport,
  formattedBody?: string,
): Promise<{ sent: boolean; reason?: string }> {
  const targetKey = `maintainer-recap:${report.windowDays}d`;
  const auditMeta = { windowDays: report.windowDays, repoCount: report.repos.length };
  const url = envString(env, "DISCORD_WEBHOOK_URL");
  if (!url || !isValidDiscordWebhook(url)) {
    const reason = url ? "invalid_global_webhook" : "missing_global_webhook";
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.discord", actor: "loopover", targetKey, outcome: "denied", detail: reason, metadata: auditMeta });
    return { sent: false, reason };
  }
  const description = (formattedBody ?? report.summary.join("\n")).slice(0, 1800);
  const body = {
    username: "LoopOver",
    embeds: [
      {
        title: `Maintainer recap · ${report.repos.length} repo(s) · ${report.windowDays}d`,
        description,
        color: 0x0969da,
        fields: [
          { name: "Reviewed", value: `${report.totals.reviewed}`, inline: true },
          { name: "Merged", value: `${report.totals.merged}`, inline: true },
          { name: "Closed", value: `${report.totals.closed}`, inline: true },
          { name: "Gate false positives", value: `${report.totals.gateFalsePositives}/${report.totals.blocked}`, inline: true },
          { name: "Overrides", value: `${report.totals.gateOverrides}`, inline: true },
          { name: "Reversals", value: `${report.totals.reversals}`, inline: true },
        ],
        footer: { text: `LoopOver · generated ${report.generatedAt}` },
      },
    ],
  };
  try {
    await postWebhook(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }, "discord");
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.discord", actor: "loopover", targetKey, outcome: "completed", detail: "sent", metadata: auditMeta });
    return { sent: true };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 160);
    console.warn(JSON.stringify({ event: "maintainer_recap_discord_failed", message: detail }));
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.discord", actor: "loopover", targetKey, outcome: "error", detail, metadata: auditMeta });
    return { sent: false, reason: detail };
  }
}

/**
 * Deliver a maintainer recap digest (#2246, the Slack channel of #1963) as a Block Kit mrkdwn section. Sibling of
 * {@link deliverRecapToDiscord} — posts the already-{@link formatMaintainerRecap}-redacted body to `SLACK_WEBHOOK_URL`.
 * Best-effort: never throws; records `maintainer_recap_notification.slack` audit events.
 */
export async function deliverRecapToSlack(
  env: Env,
  report: RecapReport,
  formattedBody: string,
): Promise<{ sent: boolean; reason?: string }> {
  const targetKey = `maintainer-recap:${report.windowDays}d`;
  const auditMeta = { windowDays: report.windowDays, repoCount: report.repos.length };
  const webhookUrl = envString(env, "SLACK_WEBHOOK_URL");
  if (!webhookUrl || !isValidSlackWebhook(webhookUrl)) {
    const reason = webhookUrl ? "invalid_webhook" : "missing_webhook";
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.slack", actor: "loopover", targetKey, outcome: "denied", detail: reason, metadata: auditMeta });
    return { sent: false, reason };
  }
  const body = {
    text: `Maintainer recap (${report.windowDays}d)`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeSlackMrkdwnText(formattedBody).slice(0, 2900) } }],
  };
  try {
    await postWebhook(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }, "slack");
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.slack", actor: "loopover", targetKey, outcome: "completed", detail: "sent", metadata: auditMeta });
    return { sent: true };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 160);
    console.warn(JSON.stringify({ event: "maintainer_recap_slack_failed", message: detail }));
    await recordAuditEvent(env, { eventType: "maintainer_recap_notification.slack", actor: "loopover", targetKey, outcome: "error", detail, metadata: auditMeta });
    return { sent: false, reason: detail };
  }
}

/** Slack incoming-webhook URL validation — only `https://hooks.slack.com/services/…`. Exported so other
 *  Slack senders (e.g. review-recap.ts's per-repo {@link deliverRecapToSlack}) reuse the SAME validation
 *  instead of re-typing the host/path allowlist. */
export function isValidSlackWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "hooks.slack.com" && parsed.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

/** Exported alongside {@link isValidSlackWebhook} so any Slack Block Kit sender escapes mrkdwn the same way. */
export function escapeSlackMrkdwnText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Post a per-action Slack message (merged/closed/manual) to `SLACK_WEBHOOK_URL` as a Block Kit section. Best-effort:
 *  never throws. The modular self-host default — ANY repo notifies the operator's single Slack channel when
 *  `SLACK_WEBHOOK_URL` is set; unset → no-op, byte-identical to today. Sibling of {@link notifyActionToDiscord}. */
export async function notifyActionToSlack(
  env: Env,
  params: { repoFullName: string; pullNumber: number; outcome: NotifyOutcome; summary: string; submitter?: string | null | undefined },
): Promise<void> {
  const webhookUrl = (env as unknown as Record<string, unknown>).SLACK_WEBHOOK_URL;
  if (typeof webhookUrl !== "string" || !isValidSlackWebhook(webhookUrl)) {
    await auditExternalNotification(env, params, "slack", "denied", typeof webhookUrl === "string" ? "invalid_webhook" : "missing_webhook");
    return;
  }
  const meta = OUTCOME_META[params.outcome];
  const prUrl = `https://github.com/${params.repoFullName}/pull/${params.pullNumber}`;
  const prLabel = escapeSlackMrkdwnText(`${params.repoFullName}#${params.pullNumber}`);
  const lines = [`*<${prUrl}|${prLabel}>* · ${meta.word}`, escapeSlackMrkdwnText(params.summary || meta.word).slice(0, 1800)];
  if (params.submitter) lines.push(`Submitter: @${escapeSlackMrkdwnText(params.submitter)}`);
  const body = {
    text: `${params.repoFullName}#${params.pullNumber} ${meta.word}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  };
  try {
    await postWebhook(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }, "slack");
    await auditExternalNotification(env, params, "slack", "completed", "sent");
  } catch (error) {
    console.warn(JSON.stringify({ event: "slack_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
    await auditExternalNotification(env, params, "slack", "error", errorMessage(error).slice(0, 160));
  }
}
