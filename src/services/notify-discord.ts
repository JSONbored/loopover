import { recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";

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
  "jsonbored/gittensory": "GITTENSORY_DISCORD_WEBHOOK",
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
    actor: "gittensory",
    targetKey: `${params.repoFullName}#${params.pullNumber}`,
    outcome,
    detail,
    metadata: { repoFullName: params.repoFullName, pullNumber: params.pullNumber, actionOutcome: params.outcome, ...metadata },
  }).catch((error) => {
    console.warn(JSON.stringify({ ev: `${provider}_notify_audit_failed`, repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
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
    username: "Gittensory",
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
        footer: { text: `Gittensory · ${params.repoFullName}` },
      },
    ],
  };
  try {
    await postWebhook(resolved.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }, "discord");
    await auditExternalNotification(env, params, "discord", "completed", "sent", { source: resolved.source });
  } catch (error) {
    console.warn(JSON.stringify({ ev: "discord_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
    await auditExternalNotification(env, params, "discord", "error", errorMessage(error).slice(0, 160), { source: resolved.source });
  }
}

/** Slack incoming-webhook URL validation — only `https://hooks.slack.com/services/…`. */
function isValidSlackWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "hooks.slack.com" && parsed.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

function escapeSlackMrkdwnText(value: string): string {
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
    console.warn(JSON.stringify({ ev: "slack_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
    await auditExternalNotification(env, params, "slack", "error", errorMessage(error).slice(0, 160));
  }
}
