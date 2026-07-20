import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { createInstallationMilestone, listOpenInstallationMilestones } from "../../src/github/milestones";
import { createTestEnv } from "../helpers/d1";

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("github/milestones (#7427)", () => {
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
      await expect(listOpenInstallationMilestones(env, 123, malformed)).rejects.toThrow(/Invalid repository full name/);
      await expect(createInstallationMilestone(env, 123, malformed, { title: "t" })).rejects.toThrow(/Invalid repository full name/);
    }
    expect(called).toBe(false);
  });

  it("lists open milestones via the installation-token path, filtering out malformed entries", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "GET") {
        return Response.json([
          { number: 1, title: "Wave 5", description: "the wave", due_on: "2026-08-01T00:00:00Z" },
          { title: "missing number" },
          { number: 2 },
          { number: 3, title: "Wave 6", description: null, due_on: null },
        ]);
      }
      return new Response("unexpected", { status: 599 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await listOpenInstallationMilestones(env, 123, "JSONbored/loopover");
    expect(result).toEqual([
      { number: 1, title: "Wave 5", description: "the wave", dueOn: "2026-08-01T00:00:00Z" },
      { number: 3, title: "Wave 6", description: null, dueOn: null },
    ]);
    expect(calls.some((call) => call.startsWith("GET") && call.includes("state=open"))).toBe(true);
  });

  it("creates a milestone via the installation-token path, including description and dueOn when provided", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/milestones") && method === "POST") {
        return Response.json({ number: 42, title: "Wave 5", description: "the wave", due_on: "2026-08-01T00:00:00Z" });
      }
      return new Response("unexpected", { status: 599 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await createInstallationMilestone(env, 123, "JSONbored/loopover", { title: "Wave 5", description: "the wave", dueOn: "2026-08-01T00:00:00Z" });
    expect(result).toEqual({ number: 42, title: "Wave 5", description: "the wave", dueOn: "2026-08-01T00:00:00Z" });
    const createCall = calls.find((call) => call.method === "POST" && call.url.includes("/milestones"));
    expect(createCall?.body).toMatchObject({ title: "Wave 5", description: "the wave", due_on: "2026-08-01T00:00:00Z" });
  });

  it("omits description and dueOn from the request when not provided", async () => {
    const calls: { body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Response.json({ number: 1, title: "Wave 5" });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await createInstallationMilestone(env, 123, "JSONbored/loopover", { title: "Wave 5" });
    expect(calls[0]?.body).not.toHaveProperty("description");
    expect(calls[0]?.body).not.toHaveProperty("due_on");
  });

  it("returns null when GitHub's response is missing the number or title", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ description: "no title or number" });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(createInstallationMilestone(env, 123, "JSONbored/loopover", { title: "Wave 5" })).resolves.toBeNull();
  });

  it("propagates a non-2xx GitHub response instead of swallowing it", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await expect(createInstallationMilestone(env, 123, "JSONbored/loopover", { title: "Wave 5" })).rejects.toMatchObject({ status: 403 });
  });

  it("suppresses the write and returns null in a non-live mode", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("unexpected", { status: 599 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    const result = await createInstallationMilestone(env, 123, "JSONbored/loopover", { title: "Wave 5" }, "dry_run");
    expect(result).toBeNull();
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/milestones"))).toBe(false);
  });
});
