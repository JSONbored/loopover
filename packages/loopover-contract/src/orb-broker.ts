/**
 * The Orb broker's base-URL policy and its stored-secret exchange, in one place (#9521).
 *
 * `src/orb/broker-client.ts` and `packages/loopover-miner/lib/tenant-credential-resolution.ts` both
 * hit `POST /v1/orb/token` with the same bootstrap token and the same URL-safety rules. The miner
 * duplicated them and said so: a relative import into the repo's root `src/` resolves outside that
 * package's `"rootDir": "."` and fails tsc with TS6059. @loopover/contract is the home both sides can
 * reach without that -- the miner already depends on it, and the Worker already imports it.
 *
 * The duplication had already rotted: broker-client.ts dropped `"::1"` from the local-host list once
 * #8334 established that a WHATWG URL's `.hostname` always brackets an IPv6 literal, and the miner's
 * copy kept it. Harmless that time. The next divergence in a function whose whole job is deciding
 * where a bootstrap credential may be sent would not be.
 *
 * Pure by construction -- URL, fetch, and AbortSignal only, no node builtins -- because this package
 * must stay Workers-safe (see its tsconfig's `"types": []`).
 */

/** The Orb's hosted broker base; override (ORB_BROKER_URL) only to point at a private loopover deployment. */
export const DEFAULT_ORB_BROKER_URL = "https://api.loopover.ai";

/**
 * The broker's cold token mint can take many seconds when GitHub is throttling the App; allow headroom
 * so the one uncached mint completes and populates the broker-side cache (steady-state cache hits
 * return in well under a second).
 */
export const ORB_BROKER_TIMEOUT_MS = 25_000;

function isLocalBrokerHost(hostname: string): boolean {
  // `hostname` is always a WHATWG URL's `.hostname`, which brackets an IPv6 literal ([::1], never bare
  // ::1), so only the bracketed form is a reachable input here (#8334).
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The validated broker origin (+ path) to call. Guards against an attacker- or misconfiguration-
 * controlled ORB_BROKER_URL sending a bootstrap token to an unintended origin: no userinfo, no query
 * or fragment, and https unless it targets localhost development.
 */
export function orbBrokerBaseUrl(env: { ORB_BROKER_URL?: string | undefined }): string {
  const raw = env.ORB_BROKER_URL ?? DEFAULT_ORB_BROKER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ORB_BROKER_URL must be a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("ORB_BROKER_URL must not include userinfo.");
  }
  if (url.search || url.hash) {
    throw new Error("ORB_BROKER_URL must not include a query string or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalBrokerHost(url.hostname))) {
    throw new Error("ORB_BROKER_URL must use https unless it targets localhost development.");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export type BrokeredStoredSecret = { secretValue: string; secretType: string };

export type OrbBrokerEnv = {
  LOOPOVER_TENANT_SECRET_TOKEN?: string | undefined;
  ORB_BROKER_URL?: string | undefined;
};

/**
 * Exchange LOOPOVER_TENANT_SECRET_TOKEN for whatever the broker has custodied under it (#8202). The
 * stored secret's value is fixed at issue time, so every call is a fresh exchange; a caller wanting to
 * avoid repeat network calls should cache the RESULT itself, not rely on this function to.
 *
 * Throws on a non-OK response or a body missing `secretValue` -- a container with no other way to
 * reach its own secret has nothing safe to fall back to, exactly like the installation-token path's
 * own fatal-on-failure posture. A caller that genuinely can degrade (the miner, whose stores are
 * unconditionally local) wraps this rather than loosening it.
 */
export async function fetchBrokeredStoredSecret(
  env: OrbBrokerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<BrokeredStoredSecret> {
  const base = orbBrokerBaseUrl(env);
  const response = await fetchImpl(`${base}/v1/orb/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.LOOPOVER_TENANT_SECRET_TOKEN ?? ""}` },
    signal: AbortSignal.timeout(ORB_BROKER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orb broker stored-secret exchange failed (${response.status}).`);
  }
  const payload = (await response.json()) as { secretValue?: string; secretType?: string };
  if (!payload.secretValue) {
    throw new Error("Orb broker stored-secret response did not include a secretValue.");
  }
  return { secretValue: payload.secretValue, secretType: payload.secretType ?? "" };
}
