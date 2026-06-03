import { describe, expect, it, vi } from "vitest";
import { gittensoryApiRequest } from "../lib/api";
import { jsonResponse, mockFetch } from "./helpers";

describe("gittensoryApiRequest", () => {
  it("returns JSON payloads on success", async () => {
    const fetchImpl = mockFetch({
      "/v1/ping": () => jsonResponse({ ok: true }),
    });
    const payload = await gittensoryApiRequest<{ ok: boolean }>({
      apiOrigin: "http://localhost:8787",
      path: "/v1/ping",
      fetchImpl,
    });
    expect(payload.ok).toBe(true);
  });

  it("uses status fallback when error payload is missing", async () => {
    const fetchImpl = mockFetch({
      "/v1/fail": () => new Response("not-json", { status: 502 }),
    });
    await expect(
      gittensoryApiRequest({
        apiOrigin: "http://localhost:8787",
        path: "/v1/fail",
        fetchImpl,
      }),
    ).rejects.toThrow("request_failed_502");
  });

  it("surfaces API error messages", async () => {
    const fetchImpl = mockFetch({
      "/v1/fail": () => jsonResponse({ error: "device_code_required" }, 400),
    });
    await expect(
      gittensoryApiRequest({
        apiOrigin: "http://localhost:8787",
        path: "/v1/fail",
        fetchImpl,
      }),
    ).rejects.toThrow("device_code_required");
  });

  it("uses the global fetch implementation when no mock is provided", async () => {
    const fetchImpl = mockFetch({
      "/v1/ping": () => jsonResponse({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const payload = await gittensoryApiRequest<{ ok: boolean }>({
      apiOrigin: "http://localhost:8787",
      path: "/v1/ping",
    });
    expect(payload.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("never posts source contents or upload paths", async () => {
    const bodies: string[] = [];
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": (_init) => {
        if (_init?.body) bodies.push(String(_init.body));
        return jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 60, interval: 1 });
      },
    });
    await gittensoryApiRequest({
      apiOrigin: "http://localhost:8787",
      path: "/v1/auth/github/device/start",
      method: "POST",
      body: {},
      fetchImpl,
    });
    expect(bodies.join(" ")).not.toMatch(/upload|source|patch|diff|fileContent/i);
  });
});
