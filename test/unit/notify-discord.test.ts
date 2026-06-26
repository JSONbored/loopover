import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyActionToDiscord, notifyActionToSlack } from "../../src/services/notify-discord";
import { createTestEnv } from "../helpers/d1";

const HOOK = "https://discord.com/api/webhooks/123/abc";
const FALLBACK = "https://discord.com/api/webhooks/999/zzz";

function stubFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(null, { status: 204 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

// The built-in per-repo secrets (GITTENSORY_DISCORD_WEBHOOK, …) are read via cast and not declared on Env, so
// set them with Object.assign; DISCORD_WEBHOOK_URL is declared, so either path works.
const withEnv = (over: Record<string, string>): Env => Object.assign(createTestEnv(), over) as Env;
const notify = (env: Env, repo: string): Promise<void> =>
  notifyActionToDiscord(env, { repoFullName: repo, pullNumber: 1, outcome: "merged", summary: "ok" });

describe("notify-discord resolveWebhook (modular self-host fallback)", () => {
  it("a mapped repo uses its own per-channel secret", async () => {
    const calls = stubFetch();
    await notify(withEnv({ GITTENSORY_DISCORD_WEBHOOK: HOOK }), "JSONbored/gittensory");
    expect(calls).toEqual([HOOK]);
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

  it("a mapped repo whose channel secret is unset falls back to DISCORD_WEBHOOK_URL", async () => {
    const calls = stubFetch();
    // JSONbored/metagraphed is in the map, but METAGRAPHED_DISCORD_WEBHOOK is unset → fall through.
    await notify(withEnv({ DISCORD_WEBHOOK_URL: FALLBACK }), "JSONbored/metagraphed");
    expect(calls).toEqual([FALLBACK]);
  });
});

describe("notifyActionToSlack (#11 — modular self-host Slack channel)", () => {
  const SLACK = "https://hooks.slack.com/services/T0/B0/xyz";
  const slackStub = () => {
    const calls: { url: string; body: { text: string; blocks: Array<{ text: { text: string } }> } }[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status: 200 });
    });
    return calls;
  };

  it("posts a Block Kit message to SLACK_WEBHOOK_URL for any repo, including the submitter", async () => {
    const calls = slackStub();
    await notifyActionToSlack(withEnv({ SLACK_WEBHOOK_URL: SLACK }), { repoFullName: "acme/widgets", pullNumber: 7, outcome: "merged", summary: "looks good", submitter: "octocat" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SLACK);
    expect(calls[0]?.body.text).toContain("acme/widgets#7");
    expect(calls[0]?.body.blocks[0]?.text.text).toContain("looks good");
    expect(calls[0]?.body.blocks[0]?.text.text).toContain("Submitter: @octocat");
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
});
