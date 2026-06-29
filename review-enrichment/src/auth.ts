import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time `Authorization: Bearer <secret>` check. Returns false on a missing/malformed header or any
 * mismatch. Length-checks before timingSafeEqual (which throws on unequal-length buffers) — the length leak is
 * acceptable for a fixed-length shared secret.
 */
export function verifyBearer(
  header: string | undefined,
  secret: string,
): boolean {
  const expectedSecret = normalizeSharedSecret(secret);
  if (!expectedSecret) return false;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  const headerToken = normalizeSharedSecret(match?.[1]);
  if (!headerToken) return false;
  const token = Buffer.from(headerToken);
  const expected = Buffer.from(expectedSecret);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(token, expected);
}

export function normalizeSharedSecret(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value.trim();
  if (!normalized) return undefined;
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (
    normalized.length >= 2 &&
    ((first === '"' && last === '"') || (first === "'" && last === "'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized || undefined;
}
