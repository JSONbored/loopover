// Real `injectSecrets`/`revokeSecrets` implementation against the main app's token broker (#8066 -- the last
// remaining piece of #7852/#7180's provisioning core; #8064 already shipped the broker-side stored-secret type
// + revoke path this calls).
//
// control-plane's own Worker has no D1 binding of its own (src/orb/broker.ts is 100% D1-bound) and there is no
// Worker-to-Worker service-binding precedent anywhere in this repo (zero `services:` entries in any
// wrangler.jsonc) -- the established pattern self-hosted containers already use instead: `POST
// /v1/internal/orb/enrollments` to mint/store an enrollment, `POST /v1/orb/token` to exchange it. This driver
// calls the SAME two routes, just to STORE a tenant's DB credential rather than mint a GitHub token (#8064's
// `tenant_db_credential` secret type), plus a third route (#8064) to revoke it on teardown.
//
// Scope, deliberately narrow: this ONLY stores custody of the credential in the broker and hands back the
// one-time exchange secret as `bootstrapSecret` -- it does NOT itself deliver anything into a running
// container's environment. That delivery is provisioning.ts's + container-driver.ts's job (#8202): provisioning
// threads `bootstrapSecret` from this driver's `injectSecrets` result into the SAME tenant's `createContainer`
// call, which is where it actually reaches `stub.start({envVars})`. #8066's own boundary excluded delivery
// entirely; #8202 is precisely the "separate, not-yet-built infrastructure" that comment pointed at.
//
// Deliberately does NOT implement the full `TenantProvisioningDriver` interface -- only injectSecrets/
// revokeSecrets (see `SecretDriver` below). `withRealSecretDriver` (driver-factory.ts) composes this onto an
// otherwise fake/real-mixed driver, same shape as `withRealDatabaseDriver`/`withRealContainerDriver`.
//
// #9143 (defect 5, deploy blocker): an ORB tenant's own webhook secret rides in the SAME bundled enrollment as
// its database credential -- see injectTenantSecrets' own doc comment for why this bundles rather than mints a
// second enrollment/bootstrap token. `src/orb/hosted-webhook-secret.ts` (the main app, a separate workspace) is
// the consumer that unwraps this payload via `fetchBrokeredStoredSecret` and feeds it to
// `handleOrbWebhook`/`verifyGitHubSignature` -- the two files agree on the wire shape by convention (the
// existing "no cross-package import, duplicate the constant/shape" posture this whole package already uses),
// not by a shared type.
import { randomBytes } from "node:crypto";
import type { DatabaseConnectionDetails, TenantProvisioningRequest } from "./tenant-provisioning-driver.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const ORB_WEBHOOK_SECRET_BYTE_LENGTH = 32;

// #8064's own `ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL` constant, duplicated here rather than imported -- this
// package has no dependency on the main app's `src/` (a separate npm workspace, its own package.json/tsconfig),
// matching this package's established "no cross-package import" convention (see http-app.ts's
// `HOSTED_CYCLE_COMMANDS` for the identical reasoning against packages/loopover-miner).
const SECRET_TYPE_TENANT_DB_CREDENTIAL = "tenant_db_credential";

export type SecretDriverConfig = {
  /** The main app's own base URL (e.g. `https://api.loopover.ai`) -- the same host self-hosted containers
   *  already call to exchange their own enrollment secret for a GitHub token (src/orb/broker-client.ts's own
   *  default). */
  baseUrl: string;
  /** `INTERNAL_JOB_TOKEN` -- Bearer-gates every `/v1/internal/*` route in the main app, including the
   *  enrollment issuance/revoke routes this driver calls. */
  internalJobToken: string;
  /** Override for tests only -- production always uses the real `fetch`. */
  fetchImpl?: typeof fetch;
};

/** The secret-only slice of `TenantProvisioningDriver` this module actually implements. Composed onto a full
 *  driver by `withRealSecretDriver` (driver-factory.ts), never used standalone against `provisionTenant`. */
export type SecretDriver = {
  injectSecrets(request: TenantProvisioningRequest): Promise<{ secretRef?: string; bootstrapSecret?: string }>;
  revokeSecrets(request: TenantProvisioningRequest): Promise<void>;
};

class MainAppApiError extends Error {
  constructor(method: string, path: string, status: number, body: string) {
    super(`Main app API ${method} ${path} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "MainAppApiError";
  }
}

async function mainAppFetch<T>(config: SecretDriverConfig, method: string, path: string, body?: unknown): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.internalJobToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new MainAppApiError(method, path, response.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** #9143 (defect 5): a fresh, per-tenant, cryptographically random webhook secret for an ORB tenant's own
 *  container to verify inbound GitHub deliveries with -- see this module's header comment on why it's bundled
 *  into the SAME enrollment as the database credential rather than minted as a second one. Hex-encoded (not
 *  base64) purely so it reads identically to every other opaque token this codebase generates (`createHash`
 *  suffixes in neon-database-driver.ts, etc.) -- the value is never parsed back apart, only compared
 *  byte-for-byte by `verifyGitHubSignature`, so any sufficiently random encoding would do. */
function generateOrbWebhookSecret(): string {
  return randomBytes(ORB_WEBHOOK_SECRET_BYTE_LENGTH).toString("hex");
}

/** The JSON shape bundled into a single `tenant_db_credential` enrollment's `secretValue` (#8064's storage is
 *  a free-text JSON blob, keyed only by the opaque `secretType` string -- this is a private wire contract
 *  between this function and `src/orb/hosted-webhook-secret.ts`'s consumer, not a shared type). `orbWebhookSecret`
 *  is present only for `product: "orb"` tenants -- AMS's one-shot CLI image never verifies an inbound webhook,
 *  so generating one for it would be dead material with no consumer, ever. */
type TenantBootstrapPayload = { database: DatabaseConnectionDetails; orbWebhookSecret?: string };

/** Stores a tenant's already-provisioned database connection details (`request.database`, #7653) -- and, for
 *  an ORB tenant, a freshly generated webhook secret (#9143, defect 5) -- in the main app's token broker as a
 *  single #8064 `tenant_db_credential` enrollment. The WHOLE bundled payload is stored (JSON-encoded), not
 *  just the bare `connectionString` -- a later reader gets every field back, not just what it can re-parse
 *  out of a URI, mirroring `DatabaseConnectionDetails`' own "kept alongside the parts" rationale.
 *
 *  #9143 (defect 5, deploy blocker): orb-webhook-router.ts's own header comment claims a hosted tenant's
 *  container "runs the SAME self-host webhook-handling code unmodified and re-verifies independently" -- but
 *  that handler (`src/orb/webhook.ts#handleOrbWebhook`) fails closed on a missing `ORB_GITHUB_WEBHOOK_SECRET`,
 *  and `createTenantContainer` (container-driver.ts) never injected one: every correctly-signed delivery would
 *  401 forever. Rather than mint a SECOND enrollment/bootstrap-token pair purely for this one extra value
 *  (doubling the container's cold-boot exchange traffic and this driver's own interface surface for what is,
 *  from the container's perspective, a single "give me my secrets" moment), the webhook secret rides in the
 *  SAME bundle the container already fetches for its database credential -- one enrollment, one
 *  `bootstrapSecret`, one `POST /v1/orb/token` exchange at boot/first-request (`src/orb/hosted-webhook-secret.ts`
 *  is the consumer that unwraps it and feeds `handleOrbWebhook`).
 *
 *  Returns the enrollment's `enrollId` as this driver's `secretRef` -- the caller (`provisionTenant`, via its
 *  own result) must persist this to revoke it later -- AND the one-time exchange `secret` as `bootstrapSecret`
 *  (#8202): the caller threads this into the tenant's container at its next `createContainer` call, so the
 *  container can itself present it to `/v1/orb/token` and get this exact bundled payload back. */
export async function injectTenantSecrets(config: SecretDriverConfig, request: TenantProvisioningRequest): Promise<{ secretRef?: string; bootstrapSecret?: string }> {
  if (!request.database) {
    throw new Error(`injectTenantSecrets: no database connection details on the request for tenant "${request.tenant.name}"`);
  }
  const payload: TenantBootstrapPayload = {
    database: request.database,
    ...(request.product === "orb" ? { orbWebhookSecret: generateOrbWebhookSecret() } : {}),
  };
  // The route's own error responses (#8064: secret_value_required/encryption_unavailable) always pair an
  // `{error}` body with a non-2xx status -- mainAppFetch already throws on those, so there's no in-band
  // `{error}`-at-200 shape for this driver to check for separately.
  const result = await mainAppFetch<{ enrollId: string; secret: string }>(
    config,
    "POST",
    "/v1/internal/orb/enrollments",
    { secretType: SECRET_TYPE_TENANT_DB_CREDENTIAL, secretValue: JSON.stringify(payload) },
  );
  return { secretRef: result.enrollId, bootstrapSecret: result.secret };
}

/** Idempotent teardown: a request with no `secretRef` (never provisioned with a real secret driver, or already
 *  revoked and cleared from the tenant registry) is a safe no-op that never calls the broker at all -- there is
 *  nothing to revoke and no `enrollId` to address a call with, matching every other driver's teardown contract
 *  in this codebase. */
export async function revokeTenantSecrets(config: SecretDriverConfig, request: TenantProvisioningRequest): Promise<void> {
  if (!request.secretRef) return;
  await mainAppFetch(config, "POST", `/v1/internal/orb/enrollments/${request.secretRef}/revoke`, undefined);
}

/** Bundles {@link injectTenantSecrets}/{@link revokeTenantSecrets} as a {@link SecretDriver} closed over one
 *  config -- the shape `withRealSecretDriver` composes onto a full `TenantProvisioningDriver`. */
export function createSecretDriver(config: SecretDriverConfig): SecretDriver {
  return {
    injectSecrets: (request) => injectTenantSecrets(config, request),
    revokeSecrets: (request) => revokeTenantSecrets(config, request),
  };
}
