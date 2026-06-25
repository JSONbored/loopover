// Orb event RELAY (#1255) — registration side. A brokered self-host registers its public relay URL so the central
// Orb can FORWARD its repos' webhook events to the container (which reviews + acts via brokered tokens). The
// container's enrollment secret is stored ENCRYPTED here (AES-256-GCM via TOKEN_ENCRYPTION_SECRET) so the Orb can
// HMAC-sign each forwarded event with it; the container verifies the signature with its own ORB_ENROLLMENT_SECRET.
// Per-enrollment isolation (one container's secret can never forge to another), and a DB-only leak can't forge
// (the encryption key is a separate secret).
import { hashToken } from "../auth/security";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";
import { encryptSecret } from "../utils/crypto";

export type RegisterResult =
  | { ok: true; installationId: number }
  | { error: "invalid_enrollment" | "installation_not_eligible" | "invalid_relay_url" | "encryption_unavailable" };

/** Register (or update) the container's relay target for a valid enrollment. Validates the secret (→ the bound,
 *  registered, non-suspended install — same gate as the token broker), SSRF-validates the relay URL, then stores
 *  the URL + the enrollment secret encrypted at rest (for the forward-time HMAC). The container presents its OWN
 *  plaintext enrollment secret as the Bearer, so this is self-service + bound to that install. */
export async function registerOrbRelay(env: Env, secret: string, relayUrl: string): Promise<RegisterResult> {
  const row = await env.DB
    .prepare("SELECT enroll_id, installation_id, state, revoked_at FROM orb_enrollments WHERE secret_hash = ?")
    .bind(await hashToken(secret))
    .first<{ enroll_id: string; installation_id: number; state: string; revoked_at: string | null }>();
  if (!row || row.state !== "enrolled" || row.revoked_at !== null) return { error: "invalid_enrollment" };
  const install = await env.DB
    .prepare("SELECT registered, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(row.installation_id)
    .first<{ registered: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install || install.registered !== 1 || install.suspended_at !== null || install.removed_at !== null) return { error: "installation_not_eligible" };
  // SSRF guard: the Orb will POST events to this URL — it must be a public https endpoint (no loopback / private /
  // link-local host), so a registered relay URL can never coerce the Orb into hitting an internal service.
  if (!isSafeHttpUrl(relayUrl)) return { error: "invalid_relay_url" };
  if (!env.TOKEN_ENCRYPTION_SECRET) return { error: "encryption_unavailable" };
  const enc = await encryptSecret(secret, env.TOKEN_ENCRYPTION_SECRET);
  await env.DB
    .prepare("UPDATE orb_enrollments SET relay_url = ?, relay_secret_enc = ?, relay_secret_iv = ?, relay_secret_salt = ?, relay_registered_at = CURRENT_TIMESTAMP WHERE enroll_id = ?")
    .bind(relayUrl, enc.ciphertext, enc.iv, enc.salt, row.enroll_id)
    .run();
  return { ok: true, installationId: row.installation_id };
}
