export const DEFAULT_API_ORIGIN = "https://gittensory-api.aethereal.dev";

const GITHUB_TOKEN_PREFIX = /^(ghp|gho|ghu|ghs|ghr|github_pat)_/i;
const GITTENSORY_SESSION_TOKEN = /^gts_[a-f0-9]{64}$/i;

export function normalizeApiOrigin(value: string | undefined | null): string {
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

export function looksLikeGitHubPersonalAccessToken(value: string): boolean {
  return GITHUB_TOKEN_PREFIX.test(value.trim());
}

export function validateGittensorySessionToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("Gittensory session token is required.");
  if (looksLikeGitHubPersonalAccessToken(token)) {
    throw new Error("GitHub personal access tokens are not stored. Use GitHub Device Flow login instead.");
  }
  if (!GITTENSORY_SESSION_TOKEN.test(token)) {
    throw new Error("Session token must be a Gittensory session token (gts_…).");
  }
  return token;
}

export function isSessionExpired(expiresAt: string | undefined | null, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}
