// Resolves a HOSTED control-plane ORB tenant container's OWN GitHub webhook secret (#9143, defect 5 -- part
// of #8202's originally-scoped-but-never-wired brokered secret bootstrap).
//
// A normal self-host or cloud deployment sets ORB_GITHUB_WEBHOOK_SECRET directly (a wrangler secret, see
// env.d.ts) -- this is a pure passthrough for that case, with ZERO network calls, so behavior there is
// byte-identical to before this file existed.
//
// A tenant container control-plane itself starts (control-plane/src/container-driver.ts's
// createTenantContainer) has no such secret injected directly: instead it gets a one-time
// LOOPOVER_TENANT_SECRET_TOKEN (#8202) it can exchange, via fetchBrokeredStoredSecret (./broker-client.ts),
// for whatever the broker has custodied under that token's enrollment. control-plane's own secret-driver.ts
// bundles this tenant's own webhook secret into that SAME exchange (see its own header comment for why one
// bootstrap token, not two) -- the bundled JSON shape is a private wire contract between that file and this
// one, agreed by convention (this package has no dependency on control-plane/, a separate npm workspace).
//
// Before #9143, ORB_GITHUB_WEBHOOK_SECRET was simply never set on a hosted tenant container at all --
// orb-webhook-router.ts's own header comment claims the container "runs the SAME self-host webhook-handling
// code unmodified and re-verifies independently", but handleOrbWebhook (./webhook.ts) fails closed on a
// missing secret, so every correctly-signed delivery would 401 forever and GitHub would eventually disable
// the hook. fetchBrokeredStoredSecret (./broker-client.ts) already had full test coverage for exactly this
// exchange but had ZERO production call sites -- this file is that call site.
import { fetchBrokeredStoredSecret } from "./broker-client";

type HostedWebhookSecretEnv = {
  ORB_GITHUB_WEBHOOK_SECRET?: string | undefined;
  LOOPOVER_TENANT_SECRET_TOKEN?: string | undefined;
  ORB_BROKER_URL?: string | undefined;
};

/** The bundled payload control-plane's secret-driver.ts stores (JSON-encoded) under the tenant's ONE shared
 *  enrollment -- `database` is present too (the original #8064/#8066 payload), but this consumer only ever
 *  needs `orbWebhookSecret`. */
type BundledTenantSecret = { orbWebhookSecret?: string };

// Memoized in-module: handleOrbWebhook calls resolveOrbWebhookSecret on EVERY delivery, but a hosted tenant
// container is a single long-lived process for its whole container lifetime (worker.ts's OrbTenantContainer,
// sleepAfter "10m") -- the broker exchange only ever needs to happen once, not on every single webhook. A
// SUCCESSFUL resolution is cached forever (the value never changes once minted); a FAILED one is deliberately
// NOT cached, so a transient broker outage self-heals on the very next delivery instead of wedging this
// container into a permanent 401 state until it restarts.
let cachedSecret: string | undefined;
let inFlight: Promise<string | undefined> | undefined;

/** Test-only: clears both the cached value and any in-flight exchange, so each test starts from a clean
 *  slate. A real container process never needs this -- the cache is meant to outlive the whole container
 *  lifetime. */
export function resetHostedWebhookSecretCacheForTests(): void {
  cachedSecret = undefined;
  inFlight = undefined;
}

async function fetchHostedWebhookSecret(env: HostedWebhookSecretEnv, fetchImpl: typeof fetch): Promise<string | undefined> {
  const stored = await fetchBrokeredStoredSecret(env, fetchImpl);
  let bundled: BundledTenantSecret;
  try {
    bundled = JSON.parse(stored.secretValue) as BundledTenantSecret;
  } catch {
    throw new Error("hosted webhook secret bundle was not valid JSON");
  }
  return typeof bundled.orbWebhookSecret === "string" && bundled.orbWebhookSecret ? bundled.orbWebhookSecret : undefined;
}

/** The tenant container's own webhook secret: the direct env value if set (cloud/normal self-host, no network
 *  call at all), else a brokered exchange for a hosted tenant container (#8202/#9143), else `undefined` --
 *  matching handleOrbWebhook's own existing fail-closed convention (an undefined/empty secret means every
 *  signature check fails, answering 401), never a silent bypass. Concurrent callers (several webhook
 *  deliveries racing in before the first exchange resolves) share the SAME in-flight exchange rather than
 *  each triggering their own broker call. */
export async function resolveOrbWebhookSecret(env: HostedWebhookSecretEnv, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (env.ORB_GITHUB_WEBHOOK_SECRET) return env.ORB_GITHUB_WEBHOOK_SECRET;
  if (cachedSecret !== undefined) return cachedSecret;
  if (!env.LOOPOVER_TENANT_SECRET_TOKEN) return undefined;

  if (!inFlight) {
    inFlight = fetchHostedWebhookSecret(env, fetchImpl)
      .then((secret) => {
        if (secret) cachedSecret = secret;
        return secret;
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({ level: "error", event: "orb_hosted_webhook_secret_resolve_failed", message: error instanceof Error ? error.message : String(error) }),
        );
        return undefined;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
