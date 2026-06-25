// Orb event RELAY (#1255) — registration side. A brokered self-host registers its public relay URL so the central
// Orb can FORWARD its repos' webhook events to the container (which reviews + acts via brokered tokens). The
// container's enrollment secret is stored ENCRYPTED here (AES-256-GCM via TOKEN_ENCRYPTION_SECRET) so the Orb can
// HMAC-sign each forwarded event with it; the container verifies the signature with its own ORB_ENROLLMENT_SECRET.
// Per-enrollment isolation (one container's secret can never forge to another), and a DB-only leak can't forge
// (the encryption key is a separate secret).
import { hashToken } from "../auth/security";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";
import { decryptSecret, encryptSecret } from "../utils/crypto";

// The events a brokered container needs to review/act on. Installation-lifecycle + other Orb-internal events are
// deliberately NOT forwarded (the container runs under the CENTRAL Orb App, not its own, so it must not treat
// those as its own installation state).
const RELAY_FORWARD_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "issue_comment",
  "issues",
]);

/** HMAC-SHA256 hex over the raw event body — the relay signature BOTH sides compute (the Orb with the decrypted
 *  enrollment secret, the container with its own ORB_ENROLLMENT_SECRET). Web Crypto (worker + node). */
export async function relaySignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Verify a relay signature (the `sha256=<hex>` value of x-orb-signature-256) over the body with `secret`, in
 *  CONSTANT TIME (crypto.subtle.verify). The container's relay receiver uses this with its ORB_ENROLLMENT_SECRET,
 *  so only the genuine Orb (which holds the encrypted copy of that secret) can drive it. */
export async function relayVerify(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const hex = header.startsWith("sha256=") ? header.slice(7) : header;
  const sigBytes = hexToBytes(hex);
  if (!sigBytes) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
}

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

/** Forward a webhook event to the brokered self-host registered for this installation. BEST-EFFORT + fail-safe:
 *  a non-forwardable event, no registered relay, or ANY error returns without throwing (the Orb's webhook 202
 *  stands; reliability hardening — a retry queue for a down container — is a follow-up). The body is HMAC-signed
 *  with the container's enrollment secret (decrypted from the stored ciphertext); the container verifies with its
 *  own ORB_ENROLLMENT_SECRET, so only the genuine Orb can drive it. */
export async function forwardOrbEvent(
  env: Env,
  args: { eventName: string; installationId: number | null | undefined; deliveryId: string; rawBody: string },
  fetchImpl: typeof fetch = fetch,
): Promise<"forwarded" | "skipped" | "failed"> {
  if (!args.installationId || !RELAY_FORWARD_EVENTS.has(args.eventName)) return "skipped";
  const row = await env.DB
    .prepare("SELECT relay_url, relay_secret_enc, relay_secret_iv, relay_secret_salt FROM orb_enrollments WHERE installation_id = ? AND state = 'enrolled' AND revoked_at IS NULL AND relay_url IS NOT NULL")
    .bind(args.installationId)
    .first<{ relay_url: string; relay_secret_enc: string; relay_secret_iv: string; relay_secret_salt: string | null }>();
  if (!row || !env.TOKEN_ENCRYPTION_SECRET) return "skipped";
  try {
    const secret = await decryptSecret(row.relay_secret_enc, row.relay_secret_iv, env.TOKEN_ENCRYPTION_SECRET, row.relay_secret_salt);
    const signature = await relaySignature(secret, args.rawBody);
    const res = await fetchImpl(row.relay_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": args.eventName,
        "x-github-delivery": args.deliveryId,
        "x-orb-signature-256": `sha256=${signature}`,
        "user-agent": "gittensory-orb/0.1",
      },
      body: args.rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? "forwarded" : "failed";
  } catch {
    return "failed"; // a down / unreachable container (or a decrypt/sign error) must never fail the Orb's 202
  }
}
