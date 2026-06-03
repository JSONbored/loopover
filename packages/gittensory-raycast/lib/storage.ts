import { normalizeApiOrigin, validateGittensorySessionToken } from "./config";
import type { GittensorySession, StoredAuthState } from "./types";

export const STORAGE_KEYS = {
  apiOrigin: "apiOrigin",
  sessionToken: "sessionToken",
  sessionExpiresAt: "sessionExpiresAt",
  sessionLogin: "sessionLogin",
  sessionScopes: "sessionScopes",
  lastAuthenticatedAt: "lastAuthenticatedAt",
} as const;

export type SessionStorageAdapter = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

function readScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((scope): scope is string => typeof scope === "string");
    } catch {
      return [];
    }
  }
  return [];
}

const SESSION_KEYS = [
  STORAGE_KEYS.sessionToken,
  STORAGE_KEYS.sessionExpiresAt,
  STORAGE_KEYS.sessionLogin,
  STORAGE_KEYS.sessionScopes,
  STORAGE_KEYS.lastAuthenticatedAt,
] as const;

export function createMemorySessionStorage(initial: Record<string, unknown> = {}): SessionStorageAdapter {
  const state = { ...initial };
  return {
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = state[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(state, values);
    },
    async remove(keys: string[]) {
      for (const key of keys) delete state[key];
    },
  };
}

export async function loadStoredAuth(adapter: SessionStorageAdapter, defaultApiOrigin?: string): Promise<StoredAuthState> {
  const snapshot = await adapter.get([STORAGE_KEYS.apiOrigin, ...SESSION_KEYS]);
  const apiOriginValue = snapshot[STORAGE_KEYS.apiOrigin];
  const apiOrigin = normalizeApiOrigin(
    typeof apiOriginValue === "string" ? apiOriginValue : defaultApiOrigin,
  );
  const tokenValue = snapshot[STORAGE_KEYS.sessionToken];
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!token) return { apiOrigin, session: null };
  const expiresAtValue = snapshot[STORAGE_KEYS.sessionExpiresAt];
  const expiresAt = typeof expiresAtValue === "string" ? expiresAtValue : "";
  const loginValue = snapshot[STORAGE_KEYS.sessionLogin];
  const scopesValue = snapshot[STORAGE_KEYS.sessionScopes];
  const lastAuthValue = snapshot[STORAGE_KEYS.lastAuthenticatedAt];
  const session: GittensorySession = {
    token: validateGittensorySessionToken(token),
    login: typeof loginValue === "string" ? loginValue : "",
    expiresAt,
    scopes: readScopes(scopesValue),
    lastAuthenticatedAt: typeof lastAuthValue === "string" ? lastAuthValue : "",
  };
  return { apiOrigin, session };
}

export async function saveApiOrigin(adapter: SessionStorageAdapter, apiOrigin: string): Promise<void> {
  await adapter.set({ [STORAGE_KEYS.apiOrigin]: normalizeApiOrigin(apiOrigin) });
}

export async function saveSession(adapter: SessionStorageAdapter, session: Omit<GittensorySession, "lastAuthenticatedAt">): Promise<GittensorySession> {
  const record: GittensorySession = {
    token: validateGittensorySessionToken(session.token),
    login: session.login.trim(),
    expiresAt: session.expiresAt.trim(),
    scopes: session.scopes.filter((scope) => typeof scope === "string"),
    lastAuthenticatedAt: new Date().toISOString(),
  };
  await adapter.set({
    [STORAGE_KEYS.sessionToken]: record.token,
    [STORAGE_KEYS.sessionExpiresAt]: record.expiresAt,
    [STORAGE_KEYS.sessionLogin]: record.login,
    [STORAGE_KEYS.sessionScopes]: JSON.stringify(record.scopes),
    [STORAGE_KEYS.lastAuthenticatedAt]: record.lastAuthenticatedAt,
  });
  return record;
}

export async function clearStoredSession(adapter: SessionStorageAdapter): Promise<void> {
  await adapter.remove([...SESSION_KEYS]);
}

export function listPersistedStorageKeys(): string[] {
  return [STORAGE_KEYS.apiOrigin, ...SESSION_KEYS];
}
