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

// Map each repo to its operator-set webhook SECRET name (set via `wrangler secret put`). A repo with no mapping
// (or an unset secret) simply does not notify — byte-identical to today for any other repo.
const WEBHOOK_SECRET_BY_REPO: Record<string, string> = {
  "jsonbored/gittensory": "GITTENSORY_DISCORD_WEBHOOK",
  "jsonbored/metagraphed": "METAGRAPHED_DISCORD_WEBHOOK",
  "jsonbored/awesome-claude": "AWESOME_DISCORD_WEBHOOK",
};

function resolveWebhook(env: Env, repoFullName: string): string | undefined {
  // A repo with a specific mapping uses its own channel secret (the built-in map is gittensory's OWN repos).
  const name = WEBHOOK_SECRET_BY_REPO[repoFullName.toLowerCase()];
  if (name) {
    const mapped = (env as unknown as Record<string, unknown>)[name];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
  }
  // Modular self-host default: ANY repo not in the built-in map falls back to a single DISCORD_WEBHOOK_URL, so a
  // self-host operator gets per-action notifications for THEIR repos without editing this source map. Unset →
  // undefined → no-notify, byte-identical to today.
  const fallback = (env as unknown as Record<string, unknown>).DISCORD_WEBHOOK_URL;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : undefined;
}

export type NotifyOutcome = "merged" | "closed" | "manual";

const OUTCOME_META: Record<NotifyOutcome, { word: string; color: number }> = {
  merged: { word: "merged", color: 0x2ea043 },
  closed: { word: "closed", color: 0xcf222e },
  manual: { word: "manual review", color: 0xbf8700 },
};

/** Post a per-action Discord embed (merged/closed/manual) to the repo's channel. Best-effort: never throws. */
export async function notifyActionToDiscord(
  env: Env,
  params: { repoFullName: string; pullNumber: number; outcome: NotifyOutcome; summary: string; submitter?: string | null | undefined },
): Promise<void> {
  const webhookUrl = resolveWebhook(env, params.repoFullName);
  if (!webhookUrl || !isValidDiscordWebhook(webhookUrl)) return;
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
    await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.warn(JSON.stringify({ ev: "discord_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
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
  if (typeof webhookUrl !== "string" || !isValidSlackWebhook(webhookUrl)) return;
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
    await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.warn(JSON.stringify({ ev: "slack_notify_failed", repo: params.repoFullName, pull: params.pullNumber, message: errorMessage(error).slice(0, 120) }));
  }
}
