import { describe, expect, it } from "vitest";
import { looksLikeGitHubPersonalAccessToken } from "../lib/config";
import {
  clearStoredSession,
  createMemorySessionStorage,
  listPersistedStorageKeys,
  loadStoredAuth,
  saveApiOrigin,
  saveSession,
  STORAGE_KEYS,
} from "../lib/storage";
import { VALID_SESSION_TOKEN } from "./helpers";

describe("session storage", () => {
  it("persists api origin separately from session fields", async () => {
    const adapter = createMemorySessionStorage();
    await saveApiOrigin(adapter, "https://preview.example");
    expect((await loadStoredAuth(adapter)).apiOrigin).toBe("https://preview.example");
  });

  it("persists only gittensory session fields and api origin", async () => {
    const adapter = createMemorySessionStorage();
    await saveApiOrigin(adapter, "http://localhost:8787");
    const saved = await saveSession(adapter, {
      token: VALID_SESSION_TOKEN,
      login: "miner",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["read:user"],
    });
    const loaded = await loadStoredAuth(adapter);
    expect(loaded.apiOrigin).toBe("http://localhost:8787");
    expect(loaded.session?.token).toBe(VALID_SESSION_TOKEN);
    expect(loaded.session?.lastAuthenticatedAt).toBe(saved.lastAuthenticatedAt);
    const keys = listPersistedStorageKeys();
    expect(keys).toContain(STORAGE_KEYS.sessionToken);
    expect(keys).not.toContain("githubPat");
  });

  it("fills missing login and expiry fields with safe defaults", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: "http://localhost:8787",
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: 42,
      [STORAGE_KEYS.sessionLogin]: null,
      [STORAGE_KEYS.lastAuthenticatedAt]: false,
    });
    const loaded = await loadStoredAuth(adapter);
    expect(loaded.session).toMatchObject({ login: "", expiresAt: "", lastAuthenticatedAt: "" });
  });

  it("still loads expired sessions for status handlers to clear", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: "http://localhost:8787",
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2000-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
      [STORAGE_KEYS.sessionScopes]: [],
    });
    const loaded = await loadStoredAuth(adapter);
    expect(loaded.session?.token).toBe(VALID_SESSION_TOKEN);
  });

  it("rejects PAT-shaped tokens during save", async () => {
    const adapter = createMemorySessionStorage();
    await expect(
      saveSession(adapter, {
        token: "ghp_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        login: "miner",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: [],
      }),
    ).rejects.toThrow(/personal access tokens/i);
    expect(looksLikeGitHubPersonalAccessToken("ghp_x")).toBe(true);
  });

  it("returns empty scopes for invalid JSON scope payloads", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: "http://localhost:8787",
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2099-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
      [STORAGE_KEYS.sessionScopes]: "{not-json",
    });
    const loaded = await loadStoredAuth(adapter);
    expect(loaded.session?.scopes).toEqual([]);
  });

  it("clears session keys explicitly", async () => {
    const adapter = createMemorySessionStorage({ [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN });
    await clearStoredSession(adapter);
    expect(await loadStoredAuth(adapter)).toMatchObject({ session: null });
  });
});
