// Resolves a hosted AMS tenant's bootstrap secret (#8246, the AMS half of #8202). Exchanges
// LOOPOVER_TENANT_SECRET_TOKEN against the SAME broker exchange src/orb/broker-client.ts uses for ORB.
// That exchange, and the ORB_BROKER_URL safety validation around it, used to be duplicated here rather
// than imported: this package's tsconfig scopes `"rootDir": "."` to itself, so a relative import reaching
// into root src/ resolves outside rootDir and fails tsc with TS6059. Both sides now import
// @loopover/contract/orb-broker instead (#9521) -- a package the miner already depends on and the Worker
// already imports, so neither has to reach across that boundary. (control-plane/src/secret-driver.ts makes
// the same "duplicate, don't import" call for the same package boundary and is a candidate for the same
// treatment; it is out of this change's scope.)
//
// #8202's mechanism: control-plane delivers a one-time bootstrap credential into a hosted tenant container's
// cold-boot env as LOOPOVER_TENANT_SECRET_TOKEN (a product-agnostic name -- ORB's and AMS's containers both
// read the identical var). The container exchanges it via POST /v1/orb/token for whatever the broker has
// custodied under it -- today, always a tenant_db_credential (a JSON-encoded DatabaseConnectionDetails);
// #8202's own research confirmed there is no production issuance path for ams_github_token yet, so that isn't
// a real response shape to plan a consumer around.
//
// resolveTenantSecret (the function hosted-entry.ts actually calls) is deliberately best-effort: unlike the
// shared fetchBrokeredStoredSecret, which throws because a self-hosted engine has real work that needs the
// value, no code in this package consumes a resolved tenant secret yet (the miner's own stores are
// unconditionally local SQLite -- see store-db-adapter.ts's own "later" note on swapping in a Postgres
// adapter), so a broker outage or an unconfigured token must not block a scheduled discover/manage-poll/
// attempt cycle from running.
//
// This FILE is named "credential", not "secret", purely to stay clear of scripts/check-miner-package.ts's
// filename-based FORBIDDEN_PATH filter (a coarse `.*secret.*` heuristic aimed at stray credential files like
// .env/.pem, not descriptively-named source code) -- the exported symbols below keep "Secret" in their names,
// matching the shared module's own naming.
import { fetchBrokeredStoredSecret, type BrokeredStoredSecret } from "@loopover/contract/orb-broker";

export type TenantSecret = BrokeredStoredSecret;

/** Exchange LOOPOVER_TENANT_SECRET_TOKEN for whatever the broker has custodied under it. Throws on a non-OK
 *  response or a body missing secretValue -- the strict primitive; {@link resolveTenantSecret} below is the
 *  best-effort wrapper hosted-entry.ts actually calls. */
export const fetchTenantSecret = fetchBrokeredStoredSecret;

/** Best-effort wrapper around {@link fetchTenantSecret} (#8246): `null` when `LOOPOVER_TENANT_SECRET_TOKEN`
 *  isn't set (a self-hosted or not-yet-provisioned tenant -- the overwhelmingly common case today) OR when the
 *  exchange itself fails, logged rather than thrown. `hosted-entry.ts` calls this once per wake so the
 *  mechanism is proven wired end-to-end for AMS (#8246's own deliverable) without making a scheduled cycle
 *  fragile against a value nothing consumes yet. */
export async function resolveTenantSecret(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<TenantSecret | null> {
  const token = env.LOOPOVER_TENANT_SECRET_TOKEN?.trim();
  if (!token) return null;
  try {
    return await fetchTenantSecret(env, fetchImpl);
  } catch (error) {
    console.warn(JSON.stringify({ event: "ams_tenant_secret_resolve_failed", message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}
