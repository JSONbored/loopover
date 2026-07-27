// Signed, expiring token gating /loopover/shot's on-demand `?url=` render mode (#9044).
//
// The route is public + unauthenticated by design (GitHub's camo image proxy fetches it with no bearer
// token -- see routes.ts), so its only defense against an attacker requesting a render of an ARBITRARY
// allowlisted-host URL (any path under *.workers.dev/*.pages.dev, which is free for anyone to register) was
// the host allowlist itself. This token ties a render request back to a URL ORB ITSELF decided to capture:
// capture.ts mints the token when it builds the on-demand fallback link for a review comment; routes.ts
// validates it before ever calling handleShot's render path. The existing host allowlist stays in place
// underneath this as defense-in-depth (belt and suspenders), not replaced by it.
//
// Reuses this repo's existing HMAC-SHA256 primitive (utils/crypto.ts hmacHex/timingSafeEqualHex -- the same
// one verifyGitHubSignature uses) and the always-required INTERNAL_JOB_TOKEN as the signing secret, so no new
// secret needs provisioning on any existing self-host install.
import { hmacHex, timingSafeEqualHex } from "../../utils/crypto";

// Generous enough that a normal reviewer opening a PR within about a day of the comment being posted still
// gets a live render; short enough to bound this public, unauthenticated render primitive's real replay
// window. A comment's embedded link is minted once and never re-signed, so this also bounds how long a
// stale/never-viewed on-demand link stays renderable at all -- an explicit tradeoff, not an oversight (see
// this repo's own PR discussion for #9044).
export const SHOT_RENDER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function signShotRenderToken(env: Env, url: string, expiresAtMs: number): Promise<string> {
  return hmacHex(env.INTERNAL_JOB_TOKEN, `${url}:${expiresAtMs}`);
}

/** Mint the `exp=<epoch-ms>&sig=<hmac-hex>` query fragment (no leading `&`/`?`) for `url`, to append to an
 *  on-demand `/loopover/shot?url=...` link. `url` must be the EXACT string the request's own `?url=` param
 *  will decode to (matching {@link verifyShotRenderToken}'s own `url` argument) -- any difference (a
 *  different query-param ordering, an extra trailing slash) fails validation, since the signature covers the
 *  url verbatim. */
export async function mintShotRenderToken(env: Env, url: string): Promise<string> {
  const expiresAt = Date.now() + SHOT_RENDER_TOKEN_TTL_MS;
  const sig = await signShotRenderToken(env, url, expiresAt);
  return `exp=${expiresAt}&sig=${sig}`;
}

/** Validate a render request's `exp`/`sig` params against the exact `url` it's requesting. False (fail
 *  closed, matching every other guard on this public route) on a missing/malformed/expired/tampered token. */
export async function verifyShotRenderToken(env: Env, url: string, params: URLSearchParams): Promise<boolean> {
  const expParam = params.get("exp");
  const sig = params.get("sig");
  if (!expParam || !sig) return false;
  const expiresAt = Number(expParam);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const expected = await signShotRenderToken(env, url, expiresAt);
  return timingSafeEqualHex(sig, expected);
}
