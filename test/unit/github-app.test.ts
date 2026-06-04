import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createInstallationToken, createOrUpdateCheckRun, getAppInstallation, getInstallationId } from "../../src/github/app";
import type { Advisory } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("GitHub check runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a completed Gittensory check run with an installation token", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/commits/abc123/check-runs")) {
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/check-runs")) {
        const body = JSON.parse(String(init?.body)) as { name: string; conclusion: string; output: { title: string; text: string } };
        expect(body.name).toBe("Gittensory");
        expect(body.conclusion).toBe("neutral");
        expect(body.output.title).toBe("Gittensory context posted");
        expect(body.output.text).not.toMatch(/linked issue|reviewability|reward|farming|wallet|hotkey|trust score/i);
        return Response.json({ id: 42, html_url: "https://github.com/checks/42" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-1",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 1,
      headSha: "abc123",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [
        {
          code: "missing_linked_issue",
          title: "No linked issue detected",
          severity: "warning",
          detail: "No closing reference was found.",
        },
      ],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory);

    expect(result).toMatchObject({ kind: "published", id: 42 });
    expect(calls.some((url) => url.includes("/app/installations/123/access_tokens"))).toBe(true);
    expect(calls.some((url) => url.includes("/repos/JSONbored/gittensory/check-runs"))).toBe(true);
  });

  it("accepts GitHub App RSA private key PEMs for installation tokens", async () => {
    const privateKey = generateRsaPrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });

    await expect(createInstallationToken(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123)).resolves.toBe("installation-token");
  });

  it("updates an existing Gittensory check run for the same head SHA", async () => {
    const privateKey = await generatePrivateKeyPem();
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/commits/abc123/check-runs")) {
        return Response.json({ total_count: 1, check_runs: [{ id: 42, name: "Gittensory" }] });
      }
      if (url.includes("/check-runs/42")) {
        const body = JSON.parse(String(init?.body)) as { name: string; conclusion: string; output: { title: string; text: string } };
        expect(body.name).toBe("Gittensory");
        expect(body.conclusion).toBe("success");
        expect(body.output.title).toBe("Gittensory context checked");
        expect(body.output.text).not.toMatch(/reviewability|reward|farming|wallet|hotkey|trust score/i);
        return Response.json({ id: 42, html_url: "https://github.com/checks/42" });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-2",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 1,
      headSha: "abc123",
      conclusion: "success",
      severity: "info",
      title: "Gittensory advisory passed",
      summary: "Pull request advisory generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory);

    expect(result).toMatchObject({ kind: "published", id: 42 });
    expect(methods.some((call) => call.startsWith("PATCH ") && call.includes("/check-runs/42"))).toBe(true);
  });

  it("returns permission_missing outcome when GitHub returns 403", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-403",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#5",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 5,
      headSha: "def456",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory);

    expect(result).toMatchObject({ kind: "permission_missing" });
    expect((result as { kind: string; warning: string }).warning).toMatch(/Checks: write/i);
  });

  it("publishes check run with standard detail level and includes public-safe finding text", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: { output?: { text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) {
        capturedBody = JSON.parse(String(init?.body)) as { output?: { text?: string } };
        return Response.json({ id: 77, html_url: "https://github.com/checks/77" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-std",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#9",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 9,
      headSha: "bbb999",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [{ code: "missing_linked_issue", title: "No linked issue detected", severity: "warning", detail: "No closing reference." }],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory, "standard");

    expect(result).toMatchObject({ kind: "published", id: 77 });
    expect(capturedBody.output?.text).toMatch(/⚠️/);
    expect(capturedBody.output?.text).not.toMatch(/reward|wallet|hotkey|trust score|reviewability|farming/i);
  });

  it("returns permission_missing for message-based 422 permission errors", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 422 });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-422",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#6",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 6,
      headSha: "fff111",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory);
    expect(result).toMatchObject({ kind: "permission_missing" });
  });

  it("rethrows non-permission errors from the check-run API", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response("internal server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-500",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#7",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 7,
      headSha: "aaa000",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    await expect(createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory)).rejects.toThrow();
  });

  it("skips check creation when no head SHA is available", async () => {
    const result = await createOrUpdateCheckRun(createTestEnv(), 123, "JSONbored/gittensory", {
      id: "advisory-3",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 1,
      conclusion: "success",
      severity: "info",
      title: "Gittensory advisory passed",
      summary: "Pull request advisory generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    });

    expect(result).toBeNull();
  });

  it("rejects invalid repo names and missing app credentials", async () => {
    await expect(
      createOrUpdateCheckRun(createTestEnv(), 123, "invalid", {
        id: "advisory-4",
        targetType: "pull_request",
        targetKey: "invalid#1",
        repoFullName: "invalid",
        pullNumber: 1,
        headSha: "abc123",
        conclusion: "success",
        severity: "info",
        title: "Gittensory advisory passed",
        summary: "Pull request advisory generated.",
        findings: [],
        generatedAt: "2026-05-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/Invalid repository full name/);

    await expect(createInstallationToken(createTestEnv({ GITHUB_APP_PRIVATE_KEY: "" }), 123)).rejects.toThrow(/not configured/);
    expect(getInstallationId({ action: "created", installation: { id: 123 } })).toBe(123);
    expect(getInstallationId({ action: "created" })).toBeNull();
  });

  it("surfaces GitHub token response failures", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async () => new Response("bad credentials", { status: 401 }));
    await expect(createInstallationToken(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123)).rejects.toThrow(/Failed to create GitHub installation token/);

    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(createInstallationToken(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123)).rejects.toThrow(/did not include a token/);
  });

  it("fetches live GitHub App installation metadata", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          target_type: "User",
          repository_selection: "selected",
          permissions: { checks: "write", metadata: "read", pull_requests: "read", issues: "write" },
          events: ["issues", "pull_request", "repository"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const installation = await getAppInstallation(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123);

    expect(installation).toMatchObject({
      id: 123,
      account: { login: "JSONbored" },
      permissions: { checks: "write" },
      events: expect.arrayContaining(["pull_request"]),
    });
  });

  it("surfaces live GitHub App installation fetch failures", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async () => new Response("installation missing", { status: 404 }));
    await expect(getAppInstallation(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123)).rejects.toThrow(/Failed to fetch GitHub App installation/);

    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(getAppInstallation(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123)).rejects.toThrow(/did not include an id/);
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

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
