import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { createInstallationIssue } from "../../src/github/issues";
import { createTestEnv } from "../helpers/d1";

describe("createInstallationIssue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  it("rejects invalid repository names before making any GitHub call", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return Response.json({ token: "t" });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    for (const malformed of ["invalid", "owner/repo/extra", " owner/repo ", "owner/ repo", "owner /repo"]) {
      await expect(createInstallationIssue(env, 123, malformed, { title: "t", body: "b" })).rejects.toThrow(
        /Invalid repository full name/,
      );
    }
    expect(called).toBe(false);
  });

  it("creates an issue via the local GitHub App installation-token path", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/loopover/issues") && method === "POST") {
        return Response.json({ number: 501, html_url: "https://github.com/JSONbored/loopover/issues/501" });
      }
      return new Response("unexpected", { status: 599 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await createInstallationIssue(env, 123, "JSONbored/loopover", {
      title: "feat(issues): plan work",
      body: "body text",
      labels: ["enhancement", "signals"],
    });

    expect(result).toEqual({ number: 501, url: "https://github.com/JSONbored/loopover/issues/501" });
    const createCall = calls.find((call) => call.method === "POST" && call.url.includes("/issues"));
    expect((createCall?.body as { labels?: string[] })?.labels).toEqual(["enhancement", "signals"]);
  });

  it("creates an issue via the Orb broker path when no local App key is used (#7425)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "https://api.loopover.ai/v1/orb/token") {
        return Response.json({ token: "brokered-token", installationId: 123, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} });
      }
      if (url.endsWith("/repos/JSONbored/loopover/issues") && method === "POST") {
        return Response.json({ number: 777, html_url: "https://github.com/JSONbored/loopover/issues/777" });
      }
      return new Response("unexpected", { status: 599 });
    });

    // Broker mode is signaled purely by ORB_ENROLLMENT_SECRET's presence -- it takes priority over any local App
    // key, so this proves the SAME call site works unmodified whether the deployment holds an App key or not.
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    const result = await createInstallationIssue(env, 123, "JSONbored/loopover", { title: "t", body: "b" });

    expect(result).toEqual({ number: 777, url: "https://github.com/JSONbored/loopover/issues/777" });
    expect(calls.some((call) => call === "POST https://api.loopover.ai/v1/orb/token")).toBe(true);
  });

  it("omits the labels field when none are provided", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Response.json({ number: 1, html_url: "https://github.com/o/r/issues/1" });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await createInstallationIssue(env, 123, "o/r", { title: "t", body: "b" });
    expect(calls[0]?.body).not.toHaveProperty("labels");

    await createInstallationIssue(env, 123, "o/r", { title: "t", body: "b", labels: [] });
    expect(calls[1]?.body).not.toHaveProperty("labels");
  });

  it("returns null when GitHub's response is missing the number or html_url", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ html_url: "https://github.com/o/r/issues/1" });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(createInstallationIssue(env, 123, "o/r", { title: "t", body: "b" })).resolves.toBeNull();
  });

  it("propagates a non-2xx GitHub response instead of swallowing it", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(createInstallationIssue(env, 123, "o/r", { title: "t", body: "b" })).rejects.toMatchObject({ status: 403 });
  });

  it("suppresses the write and returns null in a non-live mode", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A non-live mode's Octokit hook must intercept BEFORE the real POST reaches fetch -- any other URL
      // reaching here means suppression silently failed.
      return new Response("unexpected", { status: 599 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await createInstallationIssue(env, 123, "o/r", { title: "t", body: "b" }, "dry_run");
    expect(result).toBeNull();
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/issues"))).toBe(false);
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
