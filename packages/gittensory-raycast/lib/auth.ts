import { gittensoryApiRequest } from "./api";
import { isSessionExpired, validateGittensorySessionToken } from "./config";
import { clearStoredSession, loadStoredAuth, saveSession, type SessionStorageAdapter } from "./storage";
import type { DeviceFlowPollResult, DeviceFlowStart, FetchLike, GittensorySession, SessionStatus, SleepFn } from "./types";

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startDeviceFlow(apiOrigin: string, fetchImpl?: FetchLike): Promise<DeviceFlowStart> {
  const payload = await gittensoryApiRequest<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval?: number;
  }>({
    apiOrigin,
    path: "/v1/auth/github/device/start",
    method: "POST",
    body: {},
    fetchImpl,
  });
  return {
    deviceCode: payload.deviceCode,
    userCode: payload.userCode,
    verificationUri: payload.verificationUri,
    expiresIn: Number(payload.expiresIn ?? 900),
    interval: Math.max(5, Number(payload.interval ?? 5)),
  };
}

export async function pollDeviceFlow(apiOrigin: string, deviceCode: string, fetchImpl?: FetchLike): Promise<DeviceFlowPollResult> {
  const payload = await gittensoryApiRequest<Record<string, unknown>>({
    apiOrigin,
    path: "/v1/auth/github/device/poll",
    method: "POST",
    body: { deviceCode },
    fetchImpl,
  });
  if (typeof payload.token === "string" && payload.token) {
    return {
      token: validateGittensorySessionToken(payload.token),
      login: typeof payload.login === "string" ? payload.login : "",
      expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : "",
      scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      lastAuthenticatedAt: new Date().toISOString(),
    };
  }
  const status = typeof payload.status === "string" ? payload.status : "error";
  if (status === "authorization_pending" || status === "slow_down") {
    return { status, message: typeof payload.message === "string" ? payload.message : undefined };
  }
  return { status: "error", message: typeof payload.message === "string" ? payload.message : status };
}

export async function loginWithDeviceFlow(
  apiOrigin: string,
  options: { fetchImpl?: FetchLike; sleep?: SleepFn; now?: () => number; onStart?: (start: DeviceFlowStart) => void | Promise<void> } = {},
): Promise<GittensorySession> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const start = await startDeviceFlow(apiOrigin, options.fetchImpl);
  if (options.onStart) await options.onStart(start);
  const deadline = now() + start.expiresIn * 1000;
  let intervalMs = start.interval * 1000;
  while (now() < deadline) {
    await sleep(intervalMs);
    const result = await pollDeviceFlow(apiOrigin, start.deviceCode, options.fetchImpl);
    if ("token" in result && result.token) return result;
    if (!("status" in result)) throw new Error("device_flow_invalid_response");
    if (result.status === "slow_down") intervalMs += 5000;
    if (result.status !== "authorization_pending" && result.status !== "slow_down") {
      throw new Error(result.message ?? `device_flow_${result.status}`);
    }
  }
  throw new Error("GitHub device flow expired before authorization completed.");
}

export async function fetchRemoteSessionStatus(
  apiOrigin: string,
  token: string,
  fetchImpl?: FetchLike,
): Promise<{ login: string; expiresAt?: string; scopes?: string[] }> {
  const payload = await gittensoryApiRequest<{ status?: string; login?: string; expiresAt?: string; scopes?: string[] }>({
    apiOrigin,
    path: "/v1/auth/session",
    token,
    fetchImpl,
  });
  if (payload.status !== "authenticated" || !payload.login) {
    throw new Error("signed_out");
  }
  return {
    login: payload.login,
    expiresAt: payload.expiresAt,
    scopes: payload.scopes,
  };
}

export async function logoutRemoteSession(apiOrigin: string, token: string, fetchImpl?: FetchLike): Promise<void> {
  await gittensoryApiRequest({ apiOrigin, path: "/v1/auth/logout", method: "POST", body: {}, token, fetchImpl });
}

export async function getSessionStatus(adapter: SessionStorageAdapter, fetchImpl?: FetchLike): Promise<SessionStatus> {
  const stored = await loadStoredAuth(adapter);
  if (!stored.session) return { signedIn: false };
  if (isSessionExpired(stored.session.expiresAt)) {
    await clearStoredSession(adapter);
    return { signedIn: false, expired: true };
  }
  try {
    const remote = await fetchRemoteSessionStatus(stored.apiOrigin, stored.session.token, fetchImpl);
    return {
      signedIn: true,
      login: remote.login,
      expiresAt: remote.expiresAt ?? stored.session.expiresAt,
      scopes: remote.scopes ?? stored.session.scopes,
      expired: false,
    };
  } catch {
    await clearStoredSession(adapter);
    return { signedIn: false, expired: true };
  }
}

export async function loginAndPersist(
  adapter: SessionStorageAdapter,
  apiOrigin: string,
  options: {
    fetchImpl?: FetchLike;
    sleep?: SleepFn;
    now?: () => number;
    onStart?: (start: DeviceFlowStart) => void | Promise<void>;
  } = {},
): Promise<GittensorySession> {
  const session = await loginWithDeviceFlow(apiOrigin, options);
  return saveSession(adapter, session);
}

export async function logoutAndClear(adapter: SessionStorageAdapter, fetchImpl?: FetchLike): Promise<void> {
  const stored = await loadStoredAuth(adapter);
  if (stored.session?.token) {
    try {
      await logoutRemoteSession(stored.apiOrigin, stored.session.token, fetchImpl);
    } catch {
      // Local wipe still proceeds when remote revoke fails offline.
    }
  }
  await clearStoredSession(adapter);
}
