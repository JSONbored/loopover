export const DEFAULT_API_ORIGIN = "https://api.loopover.ai";
export const EXTENSION_SESSION_REQUIRED_MESSAGE = "Set an extension session token in LoopOver extension options.";
export const EXTENSION_SESSION_EXPIRED_MESSAGE = "Extension session expired or revoked. Create a fresh extension token in LoopOver.";

export const STORAGE_KEYS = {
  apiOrigin: "apiOrigin",
  sessionToken: "sessionToken",
  sessionExpiresAt: "sessionExpiresAt",
  sessionLogin: "sessionLogin",
  sessionScopes: "sessionScopes",
  lastAuthenticatedAt: "lastAuthenticatedAt",
};

const LOCAL_SESSION_KEYS = [
  STORAGE_KEYS.sessionToken,
  STORAGE_KEYS.sessionExpiresAt,
  STORAGE_KEYS.sessionLogin,
  STORAGE_KEYS.sessionScopes,
  STORAGE_KEYS.lastAuthenticatedAt,
];

const GITHUB_TOKEN_PREFIX_PATTERN = /^(ghp|gho|ghu|ghs|ghr|github_pat)_/i;
const GITTENSORY_SESSION_PATTERN = /^gts_[a-f0-9]{64}$/i;

export function extensionStorage(chromeLike = globalThis.chrome) {
  if (!chromeLike?.storage?.local || !chromeLike?.storage?.sync) {
    throw new Error("Browser extension storage is unavailable.");
  }
  return { local: chromeLike.storage.local, sync: chromeLike.storage.sync };
}

export function normalizeApiOrigin(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_API_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return DEFAULT_API_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_API_ORIGIN;
  }
}

export function looksLikeGitHubPersonalAccessToken(value) {
  return GITHUB_TOKEN_PREFIX_PATTERN.test(String(value ?? "").trim());
}

export function validateExtensionSessionToken(value) {
  const token = String(value ?? "").trim();
  if (!token) throw new Error(EXTENSION_SESSION_REQUIRED_MESSAGE);
  if (looksLikeGitHubPersonalAccessToken(token)) {
    throw new Error("GitHub personal access tokens are not accepted. Create a LoopOver extension token instead.");
  }
  if (!GITTENSORY_SESSION_PATTERN.test(token)) {
    throw new Error("Extension tokens must be LoopOver session tokens that start with gts_.");
  }
  return token;
}

export async function loadExtensionSession(storage = extensionStorage()) {
  const [syncState, localState] = await Promise.all([
    storage.sync.get([STORAGE_KEYS.apiOrigin, ...LOCAL_SESSION_KEYS]),
    storage.local.get(LOCAL_SESSION_KEYS),
  ]);
  await purgeLegacySyncSession(syncState, storage);
  const sessionToken = typeof localState.sessionToken === "string" ? localState.sessionToken : "";
  const expiresAt = typeof localState.sessionExpiresAt === "string" ? localState.sessionExpiresAt : "";
  const sessionScopes = Array.isArray(localState.sessionScopes)
    ? localState.sessionScopes.filter((scope) => typeof scope === "string")
    : [];
  return {
    apiOrigin: normalizeApiOrigin(syncState.apiOrigin),
    sessionToken,
    expiresAt,
    login: typeof localState.sessionLogin === "string" ? localState.sessionLogin : "",
    scopes: sessionScopes,
    lastAuthenticatedAt: typeof localState.lastAuthenticatedAt === "string" ? localState.lastAuthenticatedAt : "",
    expired: isExpired(expiresAt),
  };
}

export async function saveExtensionApiOrigin(apiOrigin, storage = extensionStorage()) {
  await storage.sync.set({ [STORAGE_KEYS.apiOrigin]: normalizeApiOrigin(apiOrigin) });
}

export async function storeExtensionSessionToken(session, storage = extensionStorage()) {
  const token = validateExtensionSessionToken(session?.token);
  const next = {
    [STORAGE_KEYS.sessionToken]: token,
    [STORAGE_KEYS.sessionExpiresAt]: typeof session?.expiresAt === "string" ? session.expiresAt.trim() : "",
    [STORAGE_KEYS.sessionLogin]: typeof session?.login === "string" ? session.login.trim() : "",
    [STORAGE_KEYS.sessionScopes]: Array.isArray(session?.scopes)
      ? session.scopes.filter((scope) => typeof scope === "string")
      : [],
    [STORAGE_KEYS.lastAuthenticatedAt]: new Date().toISOString(),
  };
  await storage.local.set(next);
  await storage.sync.remove(LOCAL_SESSION_KEYS);
  return next;
}

export async function clearExtensionSession(storage = extensionStorage()) {
  await storage.local.remove(LOCAL_SESSION_KEYS);
  await storage.sync.remove(LOCAL_SESSION_KEYS);
}

export async function requireUsableExtensionSession(storage = extensionStorage()) {
  const session = await loadExtensionSession(storage);
  if (!session.sessionToken) throw new Error(EXTENSION_SESSION_REQUIRED_MESSAGE);
  if (session.expired) {
    await clearExtensionSession(storage);
    throw new Error(EXTENSION_SESSION_EXPIRED_MESSAGE);
  }
  return session;
}

export async function requestPullContext(target, options = {}) {
  const storage = options.storage ?? extensionStorage();
  const session = await requireUsableExtensionSession(storage);
  const url = new URL("/v1/extension/pull-context", session.apiOrigin);
  url.searchParams.set("owner", target.owner);
  url.searchParams.set("repo", target.repo);
  url.searchParams.set("pullNumber", String(target.pullNumber));
  return fetchExtensionJson(url, session.sessionToken, { ...options, storage });
}

export async function logoutExtensionSession(options = {}) {
  const storage = options.storage ?? extensionStorage();
  const fetchImpl = options.fetchImpl ?? fetch;
  const session = await loadExtensionSession(storage);
  if (session.sessionToken && !session.expired) {
    const url = new URL("/v1/auth/logout", session.apiOrigin);
    await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.sessionToken}`,
      },
    }).catch(() => undefined);
  }
  await clearExtensionSession(storage);
  return { ok: true };
}

async function fetchExtensionJson(url, token, options = {}) {
  const storage = options.storage ?? extensionStorage();
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 || isExtensionAuthFailure(response.status, payload)) {
    await clearExtensionSession(storage);
    throw new Error(EXTENSION_SESSION_EXPIRED_MESSAGE);
  }
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`);
  return payload;
}

function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now;
}

function isExtensionAuthFailure(status, payload) {
  if (status !== 403) return false;
  return ["browser_session_required", "extension_session_required", "insufficient_scope", "unauthorized"].includes(String(payload?.error ?? ""));
}

async function purgeLegacySyncSession(syncState, storage) {
  if (LOCAL_SESSION_KEYS.some((key) => syncState[key] !== undefined)) await storage.sync.remove(LOCAL_SESSION_KEYS);
}
