import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverRecapToDiscord, deliverRecapToSlack, notifyActionToDiscord, notifyActionToSlack, resolveDiscordWebhook } from "../../src/services/notify-discord";
import { createTestEnv } from "../helpers/d1";
import type { RecapReport } from "../../src/types";

const HOOK = "https://discord.com/api/webhooks/123/abc";
const SLACK_HOOK = "https://hooks.slack.com/services/T00/B00/xxxyyyzzz";
const FALLBACK = "https://discord.com/api/webhooks/999/zzz";
const ORIG_DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function stubFetch(status = 204): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(null, { status });
  });
  return calls;
}
afterEach(() => {
  if (ORIG_DISCORD_WEBHOOK_URL === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = ORIG_DISCORD_WEBHOOK_URL;
  vi.unstubAllGlobals();
});

// The built-in per-repo secrets (GITTENSORY_DISCORD_WEBHOOK, …) are read via cast and not declared on Env, so
// set them with Object.assign; DISCORD_WEBHOOK_URL is declared, so either path works.
const withEnv = (over: Record<string, string>): Env => Object.assign(createTestEnv(), over) as Env;
const notify = (env: Env, repo: string): Promise<void> =>
  notifyActionToDiscord(env, { repoFullName: repo, pullNumber: 1, outcome: "merged", summary: "ok" });

async function externalNotificationAudit(env: Env, provider: "discord" | "slack"): Promise<Array<{ outcome: string; detail: string; metadata_json: string }>> {
  const rows = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ? order by created_at").bind(`external_notification.${provider}`).all<{ outcome: string; detail: string; metadata_json: string }>();
  return rows.results ?? [];
}

describe("notify-discord resolveWebhook (modular self-host fallback)", () => {
  it("resolves a repo-specific DISCORD_REPO_WEBHOOKS entry case-insensitively", () => {
    const env = withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "jsonbored/metagraphed": HOOK }), DISCORD_WEBHOOK_URL: FALLBACK });
    expect(resolveDiscordWebhook(env, "JSONbored/Metagraphed")).toEqual({ status: "configured", url: HOOK, source: "repo_map" });
  });

  it("ignores malformed or non-object DISCORD_REPO_WEBHOOKS values and still resolves the global fallback", () => {
    expect(resolveDiscordWebhook(withEnv({ DISCORD_REPO_WEBHOOKS: "{not json", DISCORD_WEBHOOK_URL: FALLBACK }), "acme/widgets")).toEqual({ status: "configured", url: FALLBACK, source: "global" });
    expect(resolveDiscordWebhook(withEnv({ DISCORD_REPO_WEBHOOKS: "123", DISCORD_WEBHOOK_URL: FALLBACK }), "acme/widgets")).toEqual({ status: "configured", url: FALLBACK, source: "global" });
    expect(resolveDiscordWebhook(withEnv({ DISCORD_REPO_WEBHOOKS: "[]", DISCORD_WEBHOOK_URL: FALLBACK }), "acme/widgets")).toEqual({ status: "configured", url: FALLBACK, source: "global" });
  });

  it("REGRESSION: explicit non-string and blank DISCORD_REPO_WEBHOOKS entries fail closed", async () => {
    const env = withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "acme/widgets": 123, "acme/blank": "   " }), DISCORD_WEBHOOK_URL: FALLBACK });
    expect(resolveDiscordWebhook(env, "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_repo_webhook" });
    expect(resolveDiscordWebhook(env, "acme/blank")).toEqual({ status: "disabled", reason: "invalid_repo_webhook" });
    expect(resolveDiscordWebhook(env, "acme/other")).toEqual({ status: "configured", url: FALLBACK, source: "global" });

    const calls = stubFetch();
    await notify(env, "acme/widgets");
    await notify(env, "acme/blank");
    expect(calls).toEqual([]);
    expect(await externalNotificationAudit(env, "discord")).toEqual([
      expect.objectContaining({ outcome: "denied", detail: "invalid_repo_webhook" }),
      expect.objectContaining({ outcome: "denied", detail: "invalid_repo_webhook" }),
    ]);
  });

  it("a mapped repo uses its own per-channel secret", async () => {
    const calls = stubFetch();
    await notify(withEnv({ GITTENSORY_DISCORD_WEBHOOK: HOOK }), "JSONbored/gittensory");
    expect(calls).toEqual([HOOK]);
  });

  it("uses process.env as a self-host fallback when the runtime Env object does not carry the webhook", async () => {
    process.env.DISCORD_WEBHOOK_URL = FALLBACK;
    expect(resolveDiscordWebhook(createTestEnv(), "acme/widgets")).toEqual({ status: "configured", url: FALLBACK, source: "global" });
    process.env.DISCORD_WEBHOOK_URL = "   ";
    expect(resolveDiscordWebhook(createTestEnv(), "acme/widgets")).toEqual({ status: "disabled", reason: "missing_global_webhook" });
  });

  it("any UNmapped repo (a self-hoster's) falls back to DISCORD_WEBHOOK_URL", async () => {
    const calls = stubFetch();
    await notify(withEnv({ DISCORD_WEBHOOK_URL: FALLBACK }), "acme/widgets");
    expect(calls).toEqual([FALLBACK]);
  });

  it("no mapping + no DISCORD_WEBHOOK_URL → no notification (byte-identical to today)", async () => {
    const calls = stubFetch();
    await notify(createTestEnv(), "acme/widgets");
    expect(calls).toEqual([]);
  });

  it("REGRESSION: a mapped repo whose channel secret is unset does not fall back to the wrong global channel", async () => {
    const calls = stubFetch();
    const env = withEnv({ DISCORD_WEBHOOK_URL: FALLBACK });
    // JSONbored/metagraphed is in the legacy map. If its dedicated secret is missing, posting to the global
    // fallback sends metagraphed events into the gittensory channel.
    await notify(env, "JSONbored/metagraphed");
    expect(calls).toEqual([]);
    expect(await externalNotificationAudit(env, "discord")).toEqual([expect.objectContaining({ outcome: "denied", detail: "missing_repo_webhook" })]);
  });

  it("REGRESSION: an invalid repo-specific webhook suppresses instead of falling back to the global channel", async () => {
    const calls = stubFetch();
    const env = withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "jsonbored/metagraphed": "https://example.com/not-discord" }), DISCORD_WEBHOOK_URL: FALLBACK });
    await notify(env, "JSONbored/metagraphed");
    expect(calls).toEqual([]);
    expect(await externalNotificationAudit(env, "discord")).toEqual([expect.objectContaining({ outcome: "denied", detail: "invalid_repo_webhook" })]);
  });

  it("an invalid legacy repo secret suppresses instead of falling back to the global channel", async () => {
    const calls = stubFetch();
    const env = withEnv({ GITTENSORY_DISCORD_WEBHOOK: "https://example.com/not-discord", DISCORD_WEBHOOK_URL: FALLBACK });
    await notify(env, "JSONbored/gittensory");
    expect(calls).toEqual([]);
    expect(await externalNotificationAudit(env, "discord")).toEqual([expect.objectContaining({ outcome: "denied", detail: "invalid_repo_webhook" })]);
  });

  it("an invalid global webhook suppresses unmapped repos", async () => {
    const calls = stubFetch();
    const env = withEnv({ DISCORD_WEBHOOK_URL: "https://example.com/not-discord" });
    await notify(env, "acme/widgets");
    expect(calls).toEqual([]);
    expect(resolveDiscordWebhook(env, "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_global_webhook" });
    expect(resolveDiscordWebhook(withEnv({ DISCORD_WEBHOOK_URL: "not-a-url" }), "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_global_webhook" });
    expect(await externalNotificationAudit(env, "discord")).toEqual([expect.objectContaining({ outcome: "denied", detail: "invalid_global_webhook" })]);
  });

  it("audit failures are best-effort and never break notification suppression", async () => {
    const calls = stubFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(notify({} as Env, "acme/widgets")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("discord_notify_audit_failed"));
    warn.mockRestore();
  });

  it("audits successful Discord sends without storing the webhook URL", async () => {
    const calls = stubFetch();
    const env = withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "jsonbored/gittensory": HOOK }) });
    await notify(env, "JSONbored/gittensory");
    expect(calls).toEqual([HOOK]);
    const rows = await externalNotificationAudit(env, "discord");
    expect(rows).toEqual([expect.objectContaining({ outcome: "completed", detail: "sent" })]);
    const metadata = JSON.parse(rows[0]?.metadata_json ?? "{}");
    expect(metadata).toMatchObject({ repoFullName: "JSONbored/gittensory", pullNumber: 1, actionOutcome: "merged", source: "repo_map" });
    expect(rows[0]?.metadata_json).not.toContain("webhooks/123");
  });

  it("renders Discord's summary fallback and optional submitter field", async () => {
    const calls: Array<{ url: string; body: { embeds: Array<{ description: string; fields: Array<{ name: string; value: string; inline?: boolean }> }> } }> = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status: 204 });
    });
    await notifyActionToDiscord(withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "jsonbored/gittensory": HOOK }) }), {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 2,
      outcome: "closed",
      summary: "",
      submitter: "octocat",
    });
    expect(calls[0]?.url).toBe(HOOK);
    expect(calls[0]?.body.embeds[0]?.description).toBe("closed");
    expect(calls[0]?.body.embeds[0]?.fields).toContainEqual({ name: "Submitter", value: "@octocat", inline: true });
  });

  it("REGRESSION: audits rejected Discord webhook HTTP responses as errors", async () => {
    const calls = stubFetch(429);
    const env = withEnv({ DISCORD_REPO_WEBHOOKS: JSON.stringify({ "jsonbored/gittensory": HOOK }) });
    await notify(env, "JSONbored/gittensory");
    expect(calls).toEqual([HOOK]);
    expect(await externalNotificationAudit(env, "discord")).toEqual([expect.objectContaining({ outcome: "error", detail: "discord_webhook_http_429" })]);
  });
});

describe("notifyActionToSlack (#11 — modular self-host Slack channel)", () => {
  const SLACK = "https://hooks.slack.com/services/T0/B0/xyz";
  const slackStub = (status = 200) => {
    const calls: { url: string; body: { text: string; blocks: Array<{ text: { text: string } }> } }[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status });
    });
    return calls;
  };

  it("posts a Block Kit message to SLACK_WEBHOOK_URL for any repo, including the submitter", async () => {
    const calls = slackStub();
    const env = withEnv({ SLACK_WEBHOOK_URL: SLACK });
    await notifyActionToSlack(env, { repoFullName: "acme/widgets", pullNumber: 7, outcome: "merged", summary: "looks good", submitter: "octocat" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SLACK);
    expect(calls[0]?.body.text).toContain("acme/widgets#7");
    expect(calls[0]?.body.blocks[0]?.text.text).toContain("looks good");
    expect(calls[0]?.body.blocks[0]?.text.text).toContain("Submitter: @octocat");
    expect(await externalNotificationAudit(env, "slack")).toEqual([expect.objectContaining({ outcome: "completed", detail: "sent" })]);
  });

  it("escapes untrusted Slack mrkdwn in the summary and submitter", async () => {
    const calls = slackStub();
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: SLACK }), {
      repoFullName: "acme/widgets",
      pullNumber: 7,
      outcome: "closed",
      summary: "failed <!channel> & <https://evil.example|trusted check>",
      submitter: "octo<cat>&co",
    });
    const text = calls[0]?.body.blocks[0]?.text.text ?? "";
    expect(text).toContain("failed &lt;!channel&gt; &amp; &lt;https://evil.example|trusted check&gt;");
    expect(text).toContain("Submitter: @octo&lt;cat&gt;&amp;co");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://evil.example|trusted check>");
  });

  it("omits the submitter line when absent (and falls back to the outcome word for an empty summary)", async () => {
    const calls = slackStub();
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: SLACK }), { repoFullName: "acme/widgets", pullNumber: 7, outcome: "closed", summary: "" });
    expect(calls[0]?.body.blocks[0]?.text.text).not.toContain("Submitter");
    expect(calls[0]?.body.blocks[0]?.text.text).toContain("closed");
  });

  it("does NOT notify when SLACK_WEBHOOK_URL is unset or not a valid hooks.slack.com/services URL", async () => {
    const calls = slackStub();
    const p = { repoFullName: "acme/widgets", pullNumber: 7, outcome: "merged" as const, summary: "x" };
    await notifyActionToSlack(createTestEnv(), p); // unset
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: "https://evil.example/services/x" }), p); // wrong host
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: "http://hooks.slack.com/services/x" }), p); // not https
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/foo" }), p); // wrong path
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: "not-a-url" }), p); // unparseable
    expect(calls).toEqual([]);
  });

  it("swallows a fetch failure (best-effort, never throws)", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    await expect(notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: SLACK }), { repoFullName: "acme/widgets", pullNumber: 7, outcome: "manual", summary: "x" })).resolves.toBeUndefined();
  });

  it("REGRESSION: audits rejected Slack webhook HTTP responses as errors", async () => {
    const calls = slackStub(403);
    const env = withEnv({ SLACK_WEBHOOK_URL: SLACK });
    await notifyActionToSlack(env, { repoFullName: "acme/widgets", pullNumber: 7, outcome: "closed", summary: "x" });
    expect(calls).toHaveLength(1);
    expect(await externalNotificationAudit(env, "slack")).toEqual([expect.objectContaining({ outcome: "error", detail: "slack_webhook_http_403" })]);
  });
});

const SAMPLE_RECAP: RecapReport = {
  generatedAt: "2026-07-08T00:00:00.000Z",
  windowDays: 7,
  repos: [{ repoFullName: "acme/widgets", reviewed: 5, merged: 3, closed: 2, gateFalsePositives: 1, gateOverrides: 1, reversals: 0 }],
  totals: { reviewed: 5, merged: 3, closed: 2, blocked: 4, gateFalsePositives: 1, gateOverrides: 1, reversals: 0, gateFalsePositiveRate: 0.25 },
  summary: [
    "Maintainer recap over the last 7 day(s): 1 repo(s), 5 reviewed, 3 merged, 2 closed.",
    "Gate false-positive rate: 25% (1/4 block(s) later merged).",
    "1 maintainer override(s), 0 recommendation reversal(s).",
  ],
};

async function recapAudit(env: Env): Promise<Array<{ outcome: string; detail: string }>> {
  const rows = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by created_at").bind("maintainer_recap_notification.discord").all<{ outcome: string; detail: string }>();
  return rows.results ?? [];
}

describe("deliverRecapToDiscord (#2245 maintainer recap → Discord)", () => {
  it("posts the recap as an embed to the global DISCORD_WEBHOOK_URL and records a completed audit when configured", async () => {
    let posted: { url: string; body: string } | null = null;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      posted = { url: String(url), body: init?.body ? String(init.body) : "" };
      return new Response(null, { status: 204 });
    });
    const env = withEnv({ DISCORD_WEBHOOK_URL: HOOK });
    expect(await deliverRecapToDiscord(env, SAMPLE_RECAP)).toEqual({ sent: true });
    expect(posted).not.toBeNull();
    expect(posted!.url).toBe(HOOK);
    const parsed = JSON.parse(posted!.body) as { embeds: { title: string; description: string; fields: { name: string; value: string }[] }[] };
    const embed = parsed.embeds[0]!;
    expect(embed.title).toContain("Maintainer recap");
    expect(embed.description).toContain("Gate false-positive rate");
    expect(embed.fields.map((f) => f.name)).toContain("Reversals");
    // public-safe: the digest must never leak an economic/identity term
    expect(posted!.body.toLowerCase()).not.toMatch(/reward|wallet|hotkey|coldkey|trustscore/);
    expect(await recapAudit(env)).toEqual([expect.objectContaining({ outcome: "completed", detail: "sent" })]);
  });

  it("no-ops (never fetches) and records a denied audit when DISCORD_WEBHOOK_URL is unset", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const calls = stubFetch();
    const env = createTestEnv();
    expect(await deliverRecapToDiscord(env, SAMPLE_RECAP)).toEqual({ sent: false, reason: "missing_global_webhook" });
    expect(calls).toEqual([]);
    expect(await recapAudit(env)).toEqual([expect.objectContaining({ outcome: "denied", detail: "missing_global_webhook" })]);
  });

  it("no-ops (never fetches) and records a denied audit when DISCORD_WEBHOOK_URL fails validation (non-https)", async () => {
    const calls = stubFetch();
    const env = withEnv({ DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/1/x" });
    expect(await deliverRecapToDiscord(env, SAMPLE_RECAP)).toEqual({ sent: false, reason: "invalid_global_webhook" });
    expect(calls).toEqual([]);
    expect(await recapAudit(env)).toEqual([expect.objectContaining({ outcome: "denied", detail: "invalid_global_webhook" })]);
  });

  it("swallows a send failure — best-effort, records an error audit, never throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const env = withEnv({ DISCORD_WEBHOOK_URL: HOOK });
    expect(await deliverRecapToDiscord(env, SAMPLE_RECAP)).toEqual({ sent: false, reason: "network down" });
    expect(await recapAudit(env)).toEqual([expect.objectContaining({ outcome: "error", detail: "network down" })]);
  });
});

const FORMATTED_RECAP = "# Maintainer recap\n\n- Sample summary line.\n";

async function maintainerRecapSlackAudit(env: Env): Promise<Array<{ outcome: string; detail: string }>> {
  const rows = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by created_at").bind("maintainer_recap_notification.slack").all<{ outcome: string; detail: string }>();
  return rows.results ?? [];
}

describe("deliverRecapToSlack (#2246 maintainer RecapReport → Slack)", () => {
  it("posts the formatted recap to SLACK_WEBHOOK_URL and records a completed audit when configured", async () => {
    let posted: { url: string; body: string } | null = null;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      posted = { url: String(url), body: init?.body ? String(init.body) : "" };
      return new Response(null, { status: 204 });
    });
    const env = withEnv({ SLACK_WEBHOOK_URL: SLACK_HOOK });
    expect(await deliverRecapToSlack(env, SAMPLE_RECAP, FORMATTED_RECAP)).toEqual({ sent: true });
    expect(posted!.url).toBe(SLACK_HOOK);
    const parsed = JSON.parse(posted!.body) as { blocks: { text: { text: string } }[] };
    expect(parsed.blocks[0]?.text.text).toContain("Maintainer recap");
    expect(await maintainerRecapSlackAudit(env)).toEqual([expect.objectContaining({ outcome: "completed", detail: "sent" })]);
  });

  it("no-ops when SLACK_WEBHOOK_URL is unset", async () => {
    const calls = stubFetch();
    const env = createTestEnv();
    expect(await deliverRecapToSlack(env, SAMPLE_RECAP, FORMATTED_RECAP)).toEqual({ sent: false, reason: "missing_webhook" });
    expect(calls).toEqual([]);
  });

  it("no-ops when SLACK_WEBHOOK_URL fails validation", async () => {
    const calls = stubFetch();
    const env = withEnv({ SLACK_WEBHOOK_URL: "http://hooks.slack.com/services/T/B/X" });
    expect(await deliverRecapToSlack(env, SAMPLE_RECAP, FORMATTED_RECAP)).toEqual({ sent: false, reason: "invalid_webhook" });
    expect(calls).toEqual([]);
  });

  it("swallows a send failure — best-effort, never throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("slack network down");
    });
    const env = withEnv({ SLACK_WEBHOOK_URL: SLACK_HOOK });
    expect(await deliverRecapToSlack(env, SAMPLE_RECAP, FORMATTED_RECAP)).toEqual({ sent: false, reason: "slack network down" });
  });
});
