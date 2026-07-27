// Shared telemetry-anonymization primitive (#5680): one source of truth for the per-instance-secret HMAC
// hashing every self-hosted product (Orb's `src/selfhost/orb-collector.ts`, and AMS's own export path) uses
// to anonymize repo/PR identifiers before they leave the instance. Extracted out of Orb-only code so a second,
// independently-maintained implementation never drifts from this one -- a weaker hash or a reused secret in
// only one of the two would be a real privacy bug, not style debt.
//
// Deliberately narrow: secret PERSISTENCE (where/how it's stored -- D1 for Orb, local SQLite for AMS) stays in
// each product's own store, since that's genuinely different per product. Only the pure hash/generate math
// lives here.
import { createHmac, randomBytes } from "node:crypto";

/**
 * Generate a fresh, single-purpose 256-bit anonymization secret (64 hex chars). Each product persists this
 * once per instance in its own store and reuses it on every export, so the same raw value always hashes the
 * same way. Never derived from, or shared with, any other credential (App private keys, webhook secrets) --
 * key separation means a leaked anonymization secret can't be used to forge or decrypt anything else.
 *
 * #9147: this now also holds for Orb's opt-in federated peer-benchmark export (src/orb/federated-bundle.ts).
 * That feature signs its bundles with its OWN dedicated secret (getOrCreateFederatedSigningSecret) rather
 * than this one, and derives its instance identity from a third, independent secret
 * (getOrCreateInstanceIdentitySecret) -- so enrolling a federated peer, or rotating any one of the three
 * secrets, can never affect this anonymization secret or the always-on export that uses it.
 */
export function generateAnonSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * HMAC-SHA256 `value` with the instance's own anonymization secret, truncated to 24 hex chars. The collector
 * receiving the output never holds `secret`, so it can never reverse the hash back to the original value --
 * it can only tell that two exports carrying the same hash referred to the same underlying repo/PR.
 */
export function hmacAnonymize(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}
