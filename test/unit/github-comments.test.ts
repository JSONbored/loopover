import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrUpdateNewcomerGuideComment, createOrUpdatePrIntelligenceComment, NEWCOMER_GUIDE_COMMENT_MARKER, PR_INTELLIGENCE_COMMENT_MARKER } from "../../src/github/comments";
import { createTestEnv } from "../helpers/d1";

describe("GitHub PR intelligence comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a sticky comment when no prior Gittensory comment exists", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") return Response.json([]);
      if (url.includes("/issues/12/comments") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain(PR_INTELLIGENCE_COMMENT_MARKER);
        return Response.json({ id: 101, html_url: "https://github.com/comment/101" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nbody`,
    );

    expect(result?.id).toBe(101);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(true);
  });

  it("updates an existing sticky comment instead of duplicating it", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 101, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\nold body`, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/101") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain("new body");
        return Response.json({ id: 101, html_url: "https://github.com/comment/101" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nnew body`,
    );

    expect(result?.id).toBe(101);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/101"))).toBe(true);
  });

  it("updates a legacy PR intelligence comment into the unified panel", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 101, body: "<!-- gittensory-pr-intelligence -->\nold body", user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/101") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain(PR_INTELLIGENCE_COMMENT_MARKER);
        expect(body.body).toContain("new unified body");
        return Response.json({ id: 101, html_url: "https://github.com/comment/101" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nnew unified body`,
    );

    expect(result?.id).toBe(101);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/101"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(false);
  });

  it("updates a legacy agent-command comment into the unified panel", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 202, body: "<!-- gittensory-agent-command -->\nold command body", user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/202") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain(PR_INTELLIGENCE_COMMENT_MARKER);
        expect(body.body).toContain("command result");
        return Response.json({ id: 202, html_url: "https://github.com/comment/202" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\ncommand result`,
    );

    expect(result?.id).toBe(202);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/202"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(false);
  });

  it("ignores user-authored marker comments and creates the app sticky comment", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 666, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\nspoofed body`, user: { login: "mallory", type: "User" } }]);
      }
      if (url.includes("/issues/12/comments") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain("trusted body");
        return Response.json({ id: 102, html_url: "https://github.com/comment/102" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\ntrusted body`,
    );

    expect(result?.id).toBe(102);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/666"))).toBe(false);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(true);
  });

  it("rejects invalid repository names before calling GitHub", async () => {
    await expect(createOrUpdatePrIntelligenceComment(createTestEnv(), 123, "invalid", 12, "body")).rejects.toThrow(/Invalid repository full name/);
  });

  it("posts a newcomer-guide comment under its own marker (#803)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") return Response.json([]);
      if (url.includes("/issues/12/comments") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain(NEWCOMER_GUIDE_COMMENT_MARKER);
        return Response.json({ id: 303, html_url: "https://github.com/comment/303" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdateNewcomerGuideComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${NEWCOMER_GUIDE_COMMENT_MARKER}\nwelcome`,
    );

    expect(result?.id).toBe(303);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(true);
  });
});

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}
