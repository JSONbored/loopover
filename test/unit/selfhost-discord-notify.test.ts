import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyDiscordReview,
  resolveDiscordWebhook,
} from "../../src/selfhost/discord-notify";

const ORIG = {
  repo: process.env.DISCORD_REPO_WEBHOOKS,
  global: process.env.DISCORD_WEBHOOK_URL,
};
function setEnv(repo: string | undefined, global: string | undefined): void {
  if (repo === undefined) delete process.env.DISCORD_REPO_WEBHOOKS;
  else process.env.DISCORD_REPO_WEBHOOKS = repo;
  if (global === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = global;
}
afterEach(() => {
  setEnv(ORIG.repo, ORIG.global);
  vi.unstubAllGlobals();
});

describe("resolveDiscordWebhook", () => {
  it("returns the repo-specific webhook when configured", () => {
    setEnv(JSON.stringify({ "o/a": "https://discord/a" }), undefined);
    expect(resolveDiscordWebhook("o/a")).toBe("https://discord/a");
  });
  it("falls back to the global webhook for an unmapped repo", () => {
    setEnv(
      JSON.stringify({ "o/a": "https://discord/a" }),
      "https://discord/global",
    );
    expect(resolveDiscordWebhook("o/b")).toBe("https://discord/global");
  });
  it("returns null when nothing is configured", () => {
    setEnv(undefined, undefined);
    expect(resolveDiscordWebhook("o/a")).toBeNull();
  });
  it("ignores malformed JSON and uses the global", () => {
    setEnv("{not json", "https://discord/global");
    expect(resolveDiscordWebhook("o/a")).toBe("https://discord/global");
  });
  it("ignores a non-object map value and uses the global", () => {
    setEnv("123", "https://discord/global");
    expect(resolveDiscordWebhook("o/a")).toBe("https://discord/global");
  });
});

describe("notifyDiscordReview", () => {
  it("posts a rich embed (title repo#pr·outcome, reason, Outcome/PR/Submitter fields, footer) — closed → red", async () => {
    setEnv(
      JSON.stringify({ "JSONbored/gittensory": "https://discord/gt" }),
      undefined,
    );
    let posted: {
      url: string;
      body: {
        embeds: {
          title: string;
          url: string;
          description: string;
          color: number;
          fields: { name: string; value: string; inline: boolean }[];
          footer: { text: string };
        }[];
      };
    } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posted = { url, body: JSON.parse(init.body) };
      return new Response(null, { status: 204 });
    });
    await notifyDiscordReview({
      repoFullName: "JSONbored/gittensory",
      prNumber: 1171,
      author: "jaso0n0818",
      outcome: "closed",
      reason: "An AI reviewer flagged a likely blocking defect",
      url: "https://gh/JSONbored/gittensory/pull/1171",
    });
    const e = posted!.body.embeds[0]!;
    expect(posted!.url).toBe("https://discord/gt");
    expect(e.title).toBe("JSONbored/gittensory#1171 · closed");
    expect(e.url).toBe("https://gh/JSONbored/gittensory/pull/1171");
    expect(e.description).toBe(
      "An AI reviewer flagged a likely blocking defect",
    );
    expect(e.color).toBe(0xe74c3c); // closed → red
    expect(e.fields.map((f) => f.name)).toEqual(["Outcome", "PR", "Submitter"]);
    expect(e.fields[0]!.value).toBe("`closed`");
    expect(e.fields[1]!.value).toBe("#1171");
    expect(e.fields[2]!.value).toBe("@jaso0n0818");
    expect(e.footer.text).toBe("Gittensory · JSONbored/gittensory");
  });
  it("no-ops (no fetch) when no webhook is configured", async () => {
    setEnv(undefined, undefined);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    await notifyDiscordReview({
      repoFullName: "o/a",
      prNumber: 1,
      author: "a",
      outcome: "reviewed",
      reason: "x",
      url: "u",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("swallows fetch errors (best-effort)", async () => {
    setEnv(undefined, "https://discord/global");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(
      notifyDiscordReview({
        repoFullName: "o/a",
        prNumber: 1,
        author: "a",
        outcome: "hold",
        reason: "x",
        url: "u",
      }),
    ).resolves.toBeUndefined();
  });
  it("uses the default colour for an unknown outcome", async () => {
    setEnv(undefined, "https://discord/global");
    let color = -1;
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      color = JSON.parse(init.body).embeds[0].color;
      return new Response(null, { status: 204 });
    });
    await notifyDiscordReview({
      repoFullName: "o/a",
      prNumber: 1,
      author: "a",
      outcome: "reviewed",
      reason: "x",
      url: "u",
    });
    expect(color).toBe(0x5865f2);
  });
});
