import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyActionToDiscord } from "../../src/services/notify-discord";
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
