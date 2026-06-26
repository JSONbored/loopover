// Self-host BROKER CLIENT (#1255). A self-hosted engine exchanges its operator-issued enrollment secret for a
// short-lived GitHub installation token from the central Orb (POST /v1/orb/token), so it can act on its own repos
// WITHOUT ever holding a GitHub App private key (gittensory holds the Orb App key centrally and mints on demand —
// the das-github-mirror model). Used by createInstallationToken in broker mode; the installation-token CACHE lives
// with the App-key path in src/github/app.ts (one mint per ~hour per installation, broker or local).
//
// The signal is the ENROLLMENT SECRET's presence: a brokered self-host sets ORB_ENROLLMENT_SECRET (issued by the
// operator), cloud never does — so this path is inert on cloud and the deploy is byte-identical there.

/** The Orb's hosted broker base; override (ORB_BROKER_URL) only to point at a private gittensory deployment. */
const DEFAULT_BROKER_URL = "https://gittensory-api.aethereal.dev";
const BROKER_TIMEOUT_MS = 10_000;

function isLocalBrokerHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || (hostname === "::1" || hostname === "[::1]");
}

function orbBrokerBaseUrl(env: { ORB_BROKER_URL?: string | undefined }): string {
  const raw = env.ORB_BROKER_URL ?? DEFAULT_BROKER_URL;
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

/** True when GitHub tokens should be sourced from the central Orb broker (a brokered self-host) rather than minted
 *  locally from an App key — i.e. an enrollment secret is configured. Cloud never sets it ⇒ false there. */
export function isOrbBrokerMode(env: { ORB_ENROLLMENT_SECRET?: string | undefined }): boolean {
  return Boolean(env.ORB_ENROLLMENT_SECRET);
}

export type BrokeredInstallationToken = { token: string; installationId: number; expiresAtMs: number };

/** Exchange the enrollment secret for a brokered installation token + its expiry (ms epoch). Throws on a non-OK
 *  response (401 invalid_enrollment / 403 installation_not_eligible / 5xx) or a tokenless body — a brokered
 *  self-host holds no App key to fall back to, so a mint failure is fatal for that request exactly like the
 *  App-key path, and the queue's existing retry/dead-letter handling covers a transient broker outage. */
export async function fetchBrokeredInstallationToken(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<BrokeredInstallationToken> {
  const base = orbBrokerBaseUrl(env);
  const response = await fetchImpl(`${base}/v1/orb/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET ?? ""}` },
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orb broker token exchange failed (${response.status}).`);
  }
  const payload = (await response.json()) as { token?: string; installationId?: number; expiresAt?: string };
  if (!payload.token) {
    throw new Error("Orb broker token response did not include a token.");
  }
  // A present-but-unparseable expiresAt must fall back like an absent one: Date.parse → NaN would otherwise
  // propagate into the installation-token cache, where `cached.expiresAtMs - margin > Date.now()` is always
  // false for NaN — re-minting a brokered token on every GitHub call instead of caching it for ~an hour.
  const parsedExpiry = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
  const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 50 * 60_000;
  return { token: payload.token, installationId: payload.installationId ?? 0, expiresAtMs };
}

/** Self-register this container's PUBLIC relay URL with the central Orb on boot, so the Orb forwards this install's
 *  events to us (the event half of brokered review). BEST-EFFORT: skipped unless broker mode + a public origin are
 *  configured, and any failure (Orb down, install not registered yet, non-public origin rejected) just means no
 *  relay until the next boot — it never blocks startup or throws. The relay URL is the container's public origin +
 *  /v1/orb/relay (the receiver); the Orb SSRF-validates it, so PUBLIC_API_ORIGIN must be a real public https host. */
export async function registerOrbRelayTarget(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined; PUBLIC_API_ORIGIN?: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<"registered" | "skipped" | "failed"> {
  if (!isOrbBrokerMode(env) || !env.PUBLIC_API_ORIGIN) return "skipped";
  const relayUrl = `${env.PUBLIC_API_ORIGIN.replace(/\/+$/, "")}/v1/orb/relay`;
  try {
    const base = orbBrokerBaseUrl(env);
    const res = await fetchImpl(`${base}/v1/orb/relay/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET}`, "content-type": "application/json" }, // present — isOrbBrokerMode required it
      body: JSON.stringify({ relayUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? "registered" : "failed";
  } catch {
    return "failed";
  }
}
