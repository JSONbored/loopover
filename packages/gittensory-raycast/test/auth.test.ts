import { describe, expect, it } from "vitest";
import {
  getSessionStatus,
  loginAndPersist,
  loginWithDeviceFlow,
  logoutAndClear,
  logoutRemoteSession,
  pollDeviceFlow,
  startDeviceFlow,
} from "../lib/auth";
import { createMemorySessionStorage, loadStoredAuth, STORAGE_KEYS } from "../lib/storage";
import { jsonResponse, mockFetch, VALID_SESSION_TOKEN } from "./helpers";

const apiOrigin = "http://localhost:8787";

describe("device flow auth", () => {
  it("completes login on mocked success", async () => {
    let polls = 0;
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({
          deviceCode: "device-1",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresIn: 120,
          interval: 1,
        }),
      "/v1/auth/github/device/poll": () => {
        polls += 1;
        if (polls < 2) return jsonResponse({ status: "authorization_pending" });
        return jsonResponse({
          token: VALID_SESSION_TOKEN,
          login: "miner",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scopes: ["read:user"],
        });
      },
    });
    const session = await loginWithDeviceFlow(apiOrigin, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => Date.parse("2020-01-01T00:00:00.000Z"),
    });
    expect(session.token).toBe(VALID_SESSION_TOKEN);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("surfaces auth failure from poll errors", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 30, interval: 1 }),
      "/v1/auth/github/device/poll": () => jsonResponse({ status: "access_denied", message: "denied" }),
    });
    await expect(
      loginWithDeviceFlow(apiOrigin, { fetchImpl, sleep: async () => undefined, now: () => Date.now() }),
    ).rejects.toThrow(/denied|access_denied/i);
  });

  it("expires when poll window elapses", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 1, interval: 1 }),
      "/v1/auth/github/device/poll": () => jsonResponse({ status: "authorization_pending" }),
    });
    let now = 0;
    await expect(
      loginWithDeviceFlow(apiOrigin, {
        fetchImpl,
        sleep: async () => {
          now += 2000;
        },
        now: () => now,
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("handles slow_down polling backoff", async () => {
    let polls = 0;
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 120, interval: 1 }),
      "/v1/auth/github/device/poll": () => {
        polls += 1;
        if (polls === 1) return jsonResponse({ status: "slow_down" });
        return jsonResponse({ token: VALID_SESSION_TOKEN, login: "miner", expiresAt: "2099-01-01T00:00:00.000Z", scopes: [] });
      },
    });
    const session = await loginWithDeviceFlow(apiOrigin, { fetchImpl, sleep: async () => undefined, now: () => 0 });
    expect(session.login).toBe("miner");
  });

  it("returns pending poll status objects", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/poll": () => jsonResponse({ status: "authorization_pending", message: "waiting" }),
    });
    const result = await pollDeviceFlow(apiOrigin, "dc", fetchImpl);
    expect(result).toMatchObject({ status: "authorization_pending", message: "waiting" });
  });

  it("maps non-string poll status values to error", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/poll": () => jsonResponse({ status: 42 }),
    });
    const result = await pollDeviceFlow(apiOrigin, "dc", fetchImpl);
    expect(result).toMatchObject({ status: "error", message: "error" });
  });

  it("returns generic error status when poll payload omits message", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/poll": () => jsonResponse({ status: "expired_token" }),
    });
    const result = await pollDeviceFlow(apiOrigin, "dc", fetchImpl);
    expect(result).toMatchObject({ status: "error", message: "expired_token" });
  });

  it("rejects invalid tokens from poll payloads", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/poll": () => jsonResponse({ token: "ghp_deadbeef", login: "miner", expiresAt: "2099", scopes: [] }),
    });
    await expect(pollDeviceFlow(apiOrigin, "dc", fetchImpl)).rejects.toThrow(/personal access tokens/i);
  });

  it("persists session without leaking tokens in errors", async () => {
    const adapter = createMemorySessionStorage();
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 120, interval: 1 }),
      "/v1/auth/github/device/poll": () =>
        jsonResponse({ token: VALID_SESSION_TOKEN, login: "miner", expiresAt: "2099-01-01T00:00:00.000Z", scopes: [] }),
    });
    await loginAndPersist(adapter, apiOrigin, { fetchImpl, sleep: async () => undefined, now: () => 0 });
    const snapshot = await adapter.get([STORAGE_KEYS.sessionToken]);
    expect(snapshot[STORAGE_KEYS.sessionToken]).toBe(VALID_SESSION_TOKEN);
    try {
      await loginWithDeviceFlow(apiOrigin, {
        fetchImpl: mockFetch({ "/v1/auth/github/device/start": () => jsonResponse({ error: "fail" }, 500) }),
        sleep: async () => undefined,
        now: () => 0,
      });
    } catch (error) {
      expect(String(error)).not.toContain(VALID_SESSION_TOKEN);
    }
  });
});

describe("session status", () => {
  it("reports signed-out when no local session exists", async () => {
    const status = await getSessionStatus(createMemorySessionStorage());
    expect(status).toEqual({ signedIn: false });
  });

  it("marks locally expired sessions without calling the API", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: apiOrigin,
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2000-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
    });
    const status = await getSessionStatus(adapter, async () => {
      throw new Error("should not fetch");
    });
    expect(status).toEqual({ signedIn: false, expired: true });
  });

  it("reports signed-in status from remote session endpoint", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: apiOrigin,
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2099-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
      [STORAGE_KEYS.sessionScopes]: ["read:user"],
    });
    const fetchImpl = mockFetch({
      "/v1/auth/session": () => jsonResponse({ status: "authenticated", login: "miner", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["read:user"] }),
    });
    const status = await getSessionStatus(adapter, fetchImpl);
    expect(status).toMatchObject({ signedIn: true, login: "miner" });
  });

  it("clears storage when session expires remotely", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: apiOrigin,
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2099-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
    });
    const fetchImpl = mockFetch({
      "/v1/auth/session": () => jsonResponse({ status: "signed_out" }),
    });
    const status = await getSessionStatus(adapter, fetchImpl);
    expect(status.signedIn).toBe(false);
    expect(status.expired).toBe(true);
    const snapshot = await adapter.get([STORAGE_KEYS.sessionToken]);
    expect(snapshot[STORAGE_KEYS.sessionToken]).toBeUndefined();
  });

  it("falls back to stored scopes when remote session omits them", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: apiOrigin,
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2099-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
      [STORAGE_KEYS.sessionScopes]: JSON.stringify(["read:user"]),
    });
    const fetchImpl = mockFetch({
      "/v1/auth/session": () => jsonResponse({ status: "authenticated", login: "miner" }),
    });
    const status = await getSessionStatus(adapter, fetchImpl);
    expect(status.scopes).toEqual(["read:user"]);
  });

  it("logs out locally when no session is stored", async () => {
    await logoutAndClear(createMemorySessionStorage());
  });

  it("logs out locally even when remote revoke fails", async () => {
    const adapter = createMemorySessionStorage({
      [STORAGE_KEYS.apiOrigin]: apiOrigin,
      [STORAGE_KEYS.sessionToken]: VALID_SESSION_TOKEN,
      [STORAGE_KEYS.sessionExpiresAt]: "2099-01-01T00:00:00.000Z",
      [STORAGE_KEYS.sessionLogin]: "miner",
    });
    const fetchImpl = mockFetch({
      "/v1/auth/logout": () => jsonResponse({ error: "offline" }, 503),
    });
    await logoutAndClear(adapter, fetchImpl);
    const loaded = await loadStoredAuth(adapter);
    expect(loaded.session).toBeNull();
  });
});

describe("startDeviceFlow and pollDeviceFlow edge cases", () => {
  it("defaults timing fields when API omits them", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({
          deviceCode: "dc",
          userCode: "UC",
          verificationUri: "https://github.com/login/device",
        }),
    });
    const start = await startDeviceFlow(apiOrigin, fetchImpl);
    expect(start.expiresIn).toBe(900);
    expect(start.interval).toBe(5);
  });

  it("normalizes partial success poll payloads", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/poll": () =>
        jsonResponse({ token: VALID_SESSION_TOKEN, login: 42, expiresAt: null, scopes: "not-an-array" }),
    });
    const result = await pollDeviceFlow(apiOrigin, "dc", fetchImpl);
    expect(result).toMatchObject({
      token: VALID_SESSION_TOKEN,
      login: "",
      expiresAt: "",
      scopes: [],
    });
  });

  it("revokes remote sessions successfully", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/logout": () => jsonResponse({ ok: true, revoked: true }),
    });
    await expect(logoutRemoteSession(apiOrigin, VALID_SESSION_TOKEN, fetchImpl)).resolves.toBeUndefined();
  });
});

describe("startDeviceFlow", () => {
  it("invokes onStart before polling", async () => {
    const starts: string[] = [];
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({ deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", expiresIn: 120, interval: 1 }),
      "/v1/auth/github/device/poll": () =>
        jsonResponse({ token: VALID_SESSION_TOKEN, login: "miner", expiresAt: "2099-01-01T00:00:00.000Z", scopes: [] }),
    });
    await loginWithDeviceFlow(apiOrigin, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0,
      onStart: (start) => {
        starts.push(start.userCode);
      },
    });
    expect(starts).toEqual(["UC"]);
  });

  it("returns normalized device flow metadata", async () => {
    const fetchImpl = mockFetch({
      "/v1/auth/github/device/start": () =>
        jsonResponse({
          deviceCode: "dc",
          userCode: "UC",
          verificationUri: "https://github.com/login/device",
          expiresIn: 10,
          interval: 2,
        }),
    });
    const start = await startDeviceFlow(apiOrigin, fetchImpl);
    expect(start.interval).toBeGreaterThanOrEqual(5);
    expect(start.deviceCode).toBe("dc");
  });
});
