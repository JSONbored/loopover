// Per-repo (with global fallback) Discord notifications when gittensory publishes a review (#notify). Reads
// DISCORD_REPO_WEBHOOKS (a JSON map "owner/repo" → webhook URL) and DISCORD_WEBHOOK_URL (global fallback) from
// the environment — self-host only, and a no-op when neither is set or in a runtime without process.env.
// Best-effort: an absent or failing webhook never affects the review (all errors are swallowed).

function readConfig(): { map: Record<string, string>; global: string | null } {
  /* v8 ignore next */ // process is always defined in the self-host (node) runtime; the guard is for the Worker bundle
  const env: Record<string, string | undefined> =
    (typeof process !== "undefined" ? process.env : undefined) ?? {};
  let map: Record<string, string> = {};
  if (env.DISCORD_REPO_WEBHOOKS) {
    try {
      const parsed = JSON.parse(env.DISCORD_REPO_WEBHOOKS) as unknown;
      if (parsed && typeof parsed === "object")
        map = parsed as Record<string, string>;
    } catch {
      /* malformed map → ignore, fall back to global */
    }
  }
  return { map, global: env.DISCORD_WEBHOOK_URL ?? null };
}

/** The repo's own webhook if configured, else the global webhook, else null (notifications disabled). */
export function resolveDiscordWebhook(repoFullName: string): string | null {
  const { map, global } = readConfig();
  const repoUrl = map[repoFullName];
  return typeof repoUrl === "string" && repoUrl.length > 0
    ? repoUrl
    : global && global.length > 0
      ? global
      : null;
}

// Embed accent colour by outcome — green = good, amber = caution, red = blocked/closed (matches the hosted look).
const OUTCOME_COLORS: Record<string, number> = {
  approve: 0x2ecc71,
  approved: 0x2ecc71,
  merge: 0x2ecc71,
  merged: 0x2ecc71,
  pass: 0x2ecc71,
  clean: 0x2ecc71,
  hold: 0xf1c40f,
  warn: 0xf1c40f,
  flagged: 0xf1c40f,
  block: 0xe74c3c,
  blocked: 0xe74c3c,
  close: 0xe74c3c,
  closed: 0xe74c3c,
  fail: 0xe74c3c,
};

export interface DiscordReviewNotification {
  repoFullName: string;
  prNumber: number;
  author: string;
  outcome: string;
  reason: string;
  url: string;
}

export async function notifyDiscordReview(
  n: DiscordReviewNotification,
): Promise<void> {
  const webhook = resolveDiscordWebhook(n.repoFullName);
  if (!webhook) return;
  const color = OUTCOME_COLORS[n.outcome.toLowerCase()] ?? 0x5865f2;
  const body = {
    embeds: [
      {
        title: `${n.repoFullName}#${n.prNumber} · ${n.outcome}`.slice(0, 256),
        url: n.url,
        description: n.reason.slice(0, 2048),
        color,
        fields: [
          {
            name: "Outcome",
            value: `\`${n.outcome}\``.slice(0, 1024),
            inline: true,
          },
          { name: "PR", value: `#${n.prNumber}`, inline: true },
          {
            name: "Submitter",
            value: `@${n.author}`.slice(0, 1024),
            inline: true,
          },
        ],
        footer: { text: `Gittensory · ${n.repoFullName}`.slice(0, 2048) },
      },
    ],
  };
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort: a Discord outage must never break the review */
  }
}
