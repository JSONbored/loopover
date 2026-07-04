import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { ensurePullRequestAssignee } from "../../src/github/assignees";
import { createTestEnv } from "../helpers/d1";

describe("GitHub PR assignees (#3182)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid repository names before making GitHub calls", async () => {
    await expect(ensurePullRequestAssignee(createTestEnv(), 123, "invalid", 4, "alice")).rejects.toThrow(/Invalid repository full name/);
    await expect(ensurePullRequestAssignee(createTestEnv(), 123, "owner/repo/extra", 4, "alice")).rejects.toThrow(/Invalid repository full name/);
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return Response.json({ token: "t" });
    });
    for (const padded of [" owner/repo ", "owner/ repo", "owner /repo"]) {
      await expect(ensurePullRequestAssignee(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, padded, 4, "alice")).rejects.toThrow(
        /Invalid repository full name/,
      );
    }
    expect(called).toBe(false);
  });

  it("does nothing when the login is already an assignee", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4") && !url.includes("/assignees")) return Response.json({ assignees: [{ login: "Alice" }] });
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestAssignee(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "alice");

    expect(result).toEqual({ applied: true });
    expect(calls.some((call) => call.includes("/assignees") && call.startsWith("POST"))).toBe(false);
  });

  it("applies the assignee when the POST response confirms it stuck", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4") && !url.includes("/assignees")) return Response.json({ assignees: [] });
      if (url.includes("/issues/4/assignees") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { assignees?: string[] };
        expect(body).toMatchObject({ assignees: ["alice"] });
        return Response.json({ assignees: [{ login: "alice" }] });
      }
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestAssignee(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "alice");

    expect(result).toEqual({ applied: true });
  });

  it("reports NOT applied when GitHub silently drops an ineligible assignee (no push/triage access)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4") && !url.includes("/assignees")) return Response.json({ assignees: [] });
      // GitHub returns 201 with the login silently omitted -- no error, just an assignees array without it.
      if (url.includes("/issues/4/assignees") && method === "POST") return Response.json({ assignees: [] });
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestAssignee(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "external-contributor");

    expect(result).toEqual({ applied: false });
  });

  it("treats a response with no assignees field at all as an empty list, on both the GET and the POST", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // Neither response includes an `assignees` key at all -- exercises the `?? []` fallback on both reads.
      if (url.includes("/issues/4") && !url.includes("/assignees")) return Response.json({});
      if (url.includes("/issues/4/assignees") && method === "POST") return Response.json({});
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestAssignee(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "alice");

    expect(result).toEqual({ applied: false });
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
