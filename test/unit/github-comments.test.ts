import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrUpdatePrIntelligenceComment, PR_INTELLIGENCE_COMMENT_MARKER } from "../../src/github/comments";
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

  it("expires a rejected cached installation token and retries PR panel publication once", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mints = 0;
    let rejectedReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: mints === 1 ? "stale-token" : "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.includes("/issues/12/comments") && auth.includes("stale-token")) {
        rejectedReads += 1;
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        expect(auth).toContain("fresh-token");
        return Response.json([]);
      }
      if (url.includes("/issues/12/comments") && init?.method === "POST") {
        expect(auth).toContain("fresh-token");
        return Response.json({ id: 515, html_url: "https://github.com/comment/515" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      9988,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nbody`,
    );

    expect(result?.id).toBe(515);
    expect(mints).toBe(2);
    expect(rejectedReads).toBe(1);
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

  it("prunes duplicate bot marker comments while updating the canonical sticky comment", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([
          { id: 202, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\n\nreviewing placeholder`, user: { login: "gittensory-orb[bot]", type: "Bot" } },
          { id: 101, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\nold final`, user: { login: "gittensory-orb[bot]", type: "Bot" } },
          { id: 303, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\nsecond duplicate`, user: { login: "gittensory-orb[bot]", type: "Bot" } },
        ]);
      }
      if (url.includes("/issues/comments/202") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/issues/comments/303") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/issues/comments/101") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain("new final");
        return Response.json({ id: 101, html_url: "https://github.com/comment/101" });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_SLUG: "gittensory-orb" }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nnew final`,
    );

    expect(result?.id).toBe(101);
    expect(calls.filter((call) => call.startsWith("DELETE ") && call.includes("/issues/comments/")).sort()).toEqual([
      "DELETE https://api.github.com/repos/JSONbored/gittensory/issues/comments/202",
      "DELETE https://api.github.com/repos/JSONbored/gittensory/issues/comments/303",
    ]);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/101"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(false);
  });

  it("finds the existing bot comment on page 2 and updates it rather than creating a duplicate", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page === 1) {
          // 100 human comments — no bot comment yet
          return Response.json(
            Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `human comment ${i + 1}`, user: { login: "contributor", type: "User" } })),
          );
        }
        // Bot comment is on page 2
        return Response.json([{ id: 999, body: `${PR_INTELLIGENCE_COMMENT_MARKER}\nold body`, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/999") && init?.method === "PATCH") {
        return Response.json({ id: 999, html_url: "https://github.com/comment/999" });
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

    expect(result?.id).toBe(999);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/999"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(false);
  });


  it("bounds sticky comment lookup to protect comment publication from unbounded pagination", async () => {
    const privateKey = await generatePrivateKeyPem();
    const commentListCalls: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        commentListCalls.push(page);
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, body: `human comment ${page}-${i}`, user: { login: "contributor", type: "User" } })),
        );
      }
      if (url.includes("/issues/12/comments") && init?.method === "POST") {
        return Response.json({ id: 303, html_url: "https://github.com/comment/303" });
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

    expect(result?.id).toBe(303);
    expect(commentListCalls).toEqual([1, 2, 3]);
  });

  it("returns null without creating a late first comment when createIfMissing is false", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      12,
      `${PR_INTELLIGENCE_COMMENT_MARKER}\nbody`,
      { createIfMissing: false },
    );

    expect(result).toBeNull();
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/issues/12/comments"))).toBe(false);
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

  it("skips the PATCH when the existing sticky comment body is byte-identical (#4 idempotency), keeping html_url", async () => {
    const privateKey = await generatePrivateKeyPem();
    const body = `${PR_INTELLIGENCE_COMMENT_MARKER}\nidentical body`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 101, body, html_url: "https://github.com/comment/101", user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "JSONbored/gittensory", 12, body);

    expect(result).toEqual({ id: 101, html_url: "https://github.com/comment/101" }); // html_url-present branch of the early return
    expect(calls.some((call) => call.startsWith("PATCH "))).toBe(false); // identical body → NO GitHub write
  });

  it("skips the PATCH on an identical body even when the existing comment has no html_url (#4 idempotency)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const body = `${PR_INTELLIGENCE_COMMENT_MARKER}\nidentical body`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/12/comments") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: 202, body, user: { login: "gittensory[bot]", type: "Bot" } }]); // no html_url field
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePrIntelligenceComment(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "JSONbored/gittensory", 12, body);

    expect(result).toEqual({ id: 202 }); // html_url-absent branch → no html_url key on the early return
    expect(calls.some((call) => call.startsWith("PATCH "))).toBe(false);
  });

  it("rejects invalid repository names before calling GitHub", async () => {
    await expect(createOrUpdatePrIntelligenceComment(createTestEnv(), 123, "invalid", 12, "body")).rejects.toThrow(/Invalid repository full name/);
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
