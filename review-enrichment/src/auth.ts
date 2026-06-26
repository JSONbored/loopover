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
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(token, expected);
}
