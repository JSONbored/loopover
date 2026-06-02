import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The extension runtime files are plain MV3 JavaScript, intentionally unbundled.
import * as extensionAuth from "../../apps/gittensory-extension/auth.js";

const {
  EXTENSION_SESSION_EXPIRED_MESSAGE,
  loadExtensionSession,
  logoutExtensionSession,
  requestPullContext,
  saveExtensionApiOrigin,
  storeExtensionSessionToken,
  validateExtensionSessionToken,
} = extensionAuth;

const VALID_TOKEN = `gts_${"a".repeat(64)}`;

describe("extension auth storage", () => {
  it("stores session tokens only in extension local storage and keeps sync storage token-free", async () => {
    const storage = fakeExtensionStorage({
      sync: { apiOrigin: "https://gittensory-api.aethereal.dev/ignored/path", sessionToken: "legacy-sync-token" },
    });

    await saveExtensionApiOrigin("https://api.gittensory.test/v1", storage);
    await storeExtensionSessionToken(
      {
        token: VALID_TOKEN,
        expiresAt: "2030-01-01T00:00:00.000Z",
        login: "oktofeesh1",
        scopes: ["extension:pull_context", 123],
      },
      storage,
    );

    const session = await loadExtensionSession(storage);
    expect(session).toMatchObject({
      apiOrigin: "https://api.gittensory.test",
      sessionToken: VALID_TOKEN,
      expiresAt: "2030-01-01T00:00:00.000Z",
      login: "oktofeesh1",
      scopes: ["extension:pull_context"],
      expired: false,
    });
    expect(storage.sync.dump()).toEqual({ apiOrigin: "https://api.gittensory.test" });
    expect(storage.local.dump()).toMatchObject({ sessionToken: VALID_TOKEN, sessionScopes: ["extension:pull_context"] });
  });

  it("rejects GitHub personal access tokens and malformed tokens before storage", async () => {
    const storage = fakeExtensionStorage();

    expect(() => validateExtensionSessionToken("github_pat_123")).toThrow(/GitHub personal access tokens/i);
    await expect(storeExtensionSessionToken({ token: "ghp_123" }, storage)).rejects.toThrow(/GitHub personal access tokens/i);
    await expect(storeExtensionSessionToken({ token: "not-a-gittensory-session" }, storage)).rejects.toThrow(/gts_/i);
    expect(storage.local.dump()).toEqual({});
    expect(storage.sync.dump()).toEqual({});
  });

  it("clears locally expired sessions without calling the API", async () => {
    const storage = fakeExtensionStorage({
      sync: { apiOrigin: "https://api.gittensory.test" },
      local: { sessionToken: VALID_TOKEN, sessionExpiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const fetchImpl = vi.fn();

    await expect(requestPullContext({ owner: "JSONbored", repo: "gittensory", pullNumber: 148 }, { storage, fetchImpl })).rejects.toThrow(EXTENSION_SESSION_EXPIRED_MESSAGE);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.local.dump()).toEqual({});
    expect(storage.sync.dump()).toEqual({ apiOrigin: "https://api.gittensory.test" });
  });

  it("clears revoked or insufficient-scope sessions returned by the API", async () => {
    const storage = fakeExtensionStorage({
      sync: { apiOrigin: "https://api.gittensory.test" },
      local: { sessionToken: VALID_TOKEN, sessionExpiresAt: "2030-01-01T00:00:00.000Z" },
    });
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: "extension_session_required" }));

    await expect(requestPullContext({ owner: "JSONbored", repo: "gittensory", pullNumber: 148 }, { storage, fetchImpl })).rejects.toThrow(EXTENSION_SESSION_EXPIRED_MESSAGE);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.gittensory.test/v1/extension/pull-context?owner=JSONbored&repo=gittensory&pullNumber=148",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${VALID_TOKEN}` }) }),
    );
    expect(storage.local.dump()).toEqual({});
  });

  it("returns public-safe pull context payloads and logs out by revoking then clearing local state", async () => {
    const storage = fakeExtensionStorage({
      sync: { apiOrigin: "https://api.gittensory.test" },
      local: { sessionToken: VALID_TOKEN, sessionExpiresAt: "2030-01-01T00:00:00.000Z" },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { panels: [{ label: "Boundary", rows: [{ k: "public", v: "no" }] }] }))
      .mockRejectedValueOnce(new Error("already revoked"));

    await expect(requestPullContext({ owner: "JSONbored", repo: "gittensory", pullNumber: 148 }, { storage, fetchImpl })).resolves.toMatchObject({
      panels: [{ label: "Boundary", rows: [{ k: "public", v: "no" }] }],
    });
    await expect(logoutExtensionSession({ storage, fetchImpl })).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://api.gittensory.test/v1/auth/logout",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: `Bearer ${VALID_TOKEN}` }) }),
    );
    expect(storage.local.dump()).toEqual({});
    expect(storage.sync.dump()).toEqual({ apiOrigin: "https://api.gittensory.test" });
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Forbidden",
    async json() {
      return body;
    },
  };
}

function fakeExtensionStorage(seed: { local?: Record<string, unknown>; sync?: Record<string, unknown> } = {}) {
  return {
    local: fakeStorageArea(seed.local),
    sync: fakeStorageArea(seed.sync),
  };
}

function fakeStorageArea(seed: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    async get(keys?: string | string[]) {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values.get(key)]));
      if (typeof keys === "string") return { [keys]: values.get(keys) };
      return Object.fromEntries(values);
    },
    async set(next: Record<string, unknown>) {
      for (const [key, value] of Object.entries(next)) values.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    dump() {
      return Object.fromEntries(values);
    },
  };
}
