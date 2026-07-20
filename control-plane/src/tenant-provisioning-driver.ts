// `TenantProvisioningDriver` interface seam (#7524, part of the #7173 ORB+AMS hosting control-plane). Mirrors
// `CodingAgentDriver` (packages/loopover-engine/src/miner/coding-agent-driver.ts): a small, product-agnostic
// contract plus a minimal in-memory fake, with the orchestration (provisionTenant/deprovisionTenant) living in
// a sibling module. Implementations MAY perform real IO; this file defines only the contract and the fake.
//
// The interface names the three provisioning steps #7180's provisioning API is specified around:
// create-container, provision-DB, inject-secrets. Real drivers are OUT OF SCOPE for #7524 (blocked on an
// unmade Postgres-provider decision): a real create-container would call the Cloudflare Containers API, a real
// provision-DB the chosen Postgres provider, and a real inject-secrets would delegate to #7174's generalized
// secret broker (src/orb/broker.ts). NONE of those live paths are imported here — only the fake is.

/** Product a tenant belongs to (e.g. `"orb"` / `"ams"`). Opaque to the orchestration and forwarded verbatim to
 *  every driver step — an ORB tenant and an AMS tenant take the identical call shape (#7524's product-agnostic
 *  requirement). A free string, matching tenant-client.ts's `product?: string` ("other fields vary by product"). */
export type Product = string;

/** Product-agnostic tenant identity. Keyed by `name` — the same identifier tenant-client.ts's create/destroy
 *  admin commands address a tenant by. */
export type Tenant = {
  name: string;
};

/** The full tenant lifecycle vocabulary the #7180 provisioning API reports, passed through verbatim by
 *  tenant-client.ts. provisionTenant/deprovisionTenant only ever produce the terminal `"active"` / `"torn down"`
 *  states; `"provisioning"` (transitional) and `"suspended"` (an operator action) round out the documented set. */
export type TenantLifecycleState =
  "provisioning" | "active" | "suspended" | "torn down";

/** Everything one provision/deprovision step needs. A single request type flows through every driver method so a
 *  real and a fake driver see identical inputs, and so ORB and AMS calls are shaped identically. */
export type TenantProvisioningRequest = {
  tenant: Tenant;
  product: Product;
};

export interface TenantProvisioningDriver {
  /** Step 1 (#7180): stand up the tenant's isolated container. Real driver → Cloudflare Containers API. */
  createContainer(request: TenantProvisioningRequest): Promise<void>;
  /** Step 2 (#7180): provision the tenant's database. Real driver → the chosen Postgres provider (#7524-blocked). */
  provisionDatabase(request: TenantProvisioningRequest): Promise<void>;
  /** Step 3 (#7180): inject the tenant's secrets. A real driver delegates to #7174's generalized broker
   *  (src/orb/broker.ts); the fake only records the call. No real secrets path is imported by this package. */
  injectSecrets(request: TenantProvisioningRequest): Promise<void>;
  /** Teardown inverse of createContainer. MUST be idempotent — safe to call when the container was never
   *  created — so deprovisioning a nonexistent tenant is a no-op, never a throw. */
  destroyContainer(request: TenantProvisioningRequest): Promise<void>;
  /** Teardown inverse of provisionDatabase. Idempotent, like destroyContainer. */
  dropDatabase(request: TenantProvisioningRequest): Promise<void>;
  /** Teardown inverse of injectSecrets. Idempotent, like destroyContainer. */
  revokeSecrets(request: TenantProvisioningRequest): Promise<void>;
  /** Reachability probe: is the tenant's container currently provisioned? A real driver health-checks the
   *  container; the fake checks its in-memory map. Lets callers/tests assert "exists" after provision and
   *  "gone" after deprovision without reaching into driver internals. */
  containerExists(request: TenantProvisioningRequest): Promise<boolean>;
}

/** The driver steps a fake records, for white-box assertions on call order (e.g. teardown runs in reverse of
 *  provision). */
export type FakeDriverStep =
  | "createContainer"
  | "provisionDatabase"
  | "injectSecrets"
  | "destroyContainer"
  | "dropDatabase"
  | "revokeSecrets";

/** One recorded driver call: which step ran, and the tenant/product it ran for. */
export type FakeDriverCall = {
  step: FakeDriverStep;
  tenant: Tenant;
  product: Product;
};

/** A fake `TenantProvisioningDriver` plus the recorded state a test inspects. */
export type FakeTenantProvisioningDriver = TenantProvisioningDriver & {
  /** Tenant names whose container currently "exists" (an in-memory stand-in for real infrastructure). */
  readonly containers: ReadonlySet<string>;
  /** Tenant names whose database currently "exists". */
  readonly databases: ReadonlySet<string>;
  /** Tenant names whose secrets are currently injected. */
  readonly injectedSecrets: ReadonlySet<string>;
  /** Every driver step this fake has run, in call order. */
  readonly calls: readonly FakeDriverCall[];
};

/** Minimal in-memory fake for orchestration/contract tests — three in-memory maps stand in for real infra
 *  ("a container exists" / "a DB exists" / "secrets injected"), toggled by the create/destroy steps, plus an
 *  ordered call log. NO Cloudflare, Postgres, or secret-broker IO of any kind. Mirrors
 *  createFakeCodingAgentDriver: implements the interface and exposes its recorded state as extra introspection
 *  surface beyond the contract. */
export function createFakeTenantProvisioningDriver(): FakeTenantProvisioningDriver {
  const containers = new Set<string>();
  const databases = new Set<string>();
  const injectedSecrets = new Set<string>();
  const calls: FakeDriverCall[] = [];

  const record = (
    step: FakeDriverStep,
    request: TenantProvisioningRequest,
  ): void => {
    calls.push({ step, tenant: request.tenant, product: request.product });
  };

  return {
    get containers() {
      return containers;
    },
    get databases() {
      return databases;
    },
    get injectedSecrets() {
      return injectedSecrets;
    },
    get calls() {
      return calls;
    },
    async createContainer(request) {
      record("createContainer", request);
      containers.add(request.tenant.name);
    },
    async provisionDatabase(request) {
      record("provisionDatabase", request);
      databases.add(request.tenant.name);
    },
    async injectSecrets(request) {
      record("injectSecrets", request);
      injectedSecrets.add(request.tenant.name);
    },
    async destroyContainer(request) {
      record("destroyContainer", request);
      // Idempotent teardown: the else-branch (nothing to remove) is the "destroy-of-a-nonexistent-tenant"
      // lifecycle path — a no-op, never a throw.
      if (containers.has(request.tenant.name)) {
        containers.delete(request.tenant.name);
      }
    },
    async dropDatabase(request) {
      record("dropDatabase", request);
      if (databases.has(request.tenant.name)) {
        databases.delete(request.tenant.name);
      }
    },
    async revokeSecrets(request) {
      record("revokeSecrets", request);
      if (injectedSecrets.has(request.tenant.name)) {
        injectedSecrets.delete(request.tenant.name);
      }
    },
    async containerExists(request) {
      return containers.has(request.tenant.name);
    },
  };
}
