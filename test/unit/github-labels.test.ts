import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { ensurePullRequestLabel, removePullRequestLabel } from "../../src/github/labels";
import { createTestEnv } from "../helpers/d1";

describe("GitHub PR labels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid repository names before making GitHub calls", async () => {
    await expect(ensurePullRequestLabel(createTestEnv(), 123, "invalid", 4, "gittensor", { createMissingLabel: true })).rejects.toThrow(/Invalid repository full name/);
    await expect(ensurePullRequestLabel(createTestEnv(), 123, "owner/repo/extra", 4, "gittensor", { createMissingLabel: true })).rejects.toThrow(
      /Invalid repository full name/,
    );
    await expect(ensurePullRequestLabel(createTestEnv(), 123, " owner/repo ", 4, "gittensor", { createMissingLabel: true })).rejects.toThrow(
      /Invalid repository full name/,
    );
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return Response.json({ token: "t" });
    });
    await expect(
      ensurePullRequestLabel(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }),
        123,
        "owner/repo/extra",
        4,
        "gittensor",
        { createMissingLabel: true },
      ),
    ).rejects.toThrow(/Invalid repository full name/);
    expect(called).toBe(false);
  });

  it("removePullRequestLabel: skips malformed repository names without calling GitHub", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return Response.json({ token: "t" });
    });
    for (const repoFullName of ["invalid", "owner/repo/extra", " owner/repo "]) {
      await expect(
        removePullRequestLabel(
          createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }),
          123,
          repoFullName,
          4,
          "gittensor",
        ),
      ).resolves.toBeUndefined();
    }
    expect(called).toBe(false);
  });

  it("does nothing when the label is already applied", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4/labels")) return Response.json([{ name: "GitTensor" }]);
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestLabel(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "gittensor", {
      createMissingLabel: true,
    });

    expect(result).toEqual({ applied: false, created: false });
    expect(calls.some((call) => call.includes("/repos/JSONbored/gittensory/labels"))).toBe(false);
  });

  it("applies an existing repository label without creating it, even when the repo has more than 100 labels", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4/labels") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && method === "POST") {
        // GitHub 422 "already_exists" — label is in the repo (possibly beyond page 100)
        return Response.json(
          { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] },
          { status: 422 },
        );
      }
      if (url.includes("/issues/4/labels") && method === "POST") return Response.json([{ name: "gittensor" }]);
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestLabel(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "gittensor", {
      createMissingLabel: true,
    });

    expect(result).toEqual({ applied: true, created: false });
  });

  it("propagates a 422 that is not an already_exists duplicate (e.g. invalid label name)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4/labels") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && method === "POST") {
        return Response.json(
          { message: "Validation Failed", errors: [{ resource: "Label", code: "invalid", field: "name" }] },
          { status: 422 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(
      ensurePullRequestLabel(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "gittensor", {
        createMissingLabel: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("creates a missing repository label when configured", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4/labels") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; color?: string };
        expect(body).toMatchObject({ name: "gittensor", color: "7ee787" });
        return Response.json({ name: "gittensor" }, { status: 201 });
      }
      if (url.includes("/issues/4/labels") && method === "POST") return Response.json([{ name: "gittensor" }]);
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestLabel(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "gittensor", {
      createMissingLabel: true,
    });

    expect(result).toEqual({ applied: true, created: true });
    expect(calls).toEqual(expect.arrayContaining([expect.stringMatching(/^POST .*\/repos\/JSONbored\/gittensory\/labels$/)]));
  });

  it("applies a configured label without creating the repository label when creation is disabled", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/4/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/labels") && method === "POST") return Response.json([{ name: "gittensor" }]);
      return new Response("unexpected", { status: 500 });
    });

    const result = await ensurePullRequestLabel(createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() }), 123, "JSONbored/gittensory", 4, "gittensor", {
      createMissingLabel: false,
    });

    expect(result).toEqual({ applied: true, created: false });
    expect(calls.some((call) => call.includes("/repos/JSONbored/gittensory/labels"))).toBe(false);
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
