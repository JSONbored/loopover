// `TenantProvisioningDriver` interface seam (#7524, part of the #7173 ORB+AMS hosting control-plane). Mirrors
// `CodingAgentDriver` (packages/loopover-engine/src/miner/coding-agent-driver.ts): a small, product-agnostic
// contract plus a minimal in-memory fake, with the orchestration (provisionTenant/deprovisionTenant) living in
// a sibling module. Implementations MAY perform real IO; this file defines only the contract and the fake.
//
// The interface names the three provisioning steps #7180's provisioning API is specified around: create-
// container, provision-DB, inject-secrets. Real drivers were out of scope for #7524 itself but have since
// landed as separate, independently-composable pieces (container-driver.ts/#7851, neon-database-driver.ts/
// #7653, secret-driver.ts/#8066 delegating to #7174's generalized broker via #8064's stored-secret type) --
// see driver-factory.ts for how they compose onto this file's fake. NONE of those live paths are imported here
// — only the fake is.

/** Product a tenant belongs to (e.g. `"orb"` / `"ams"`). Opaque to the orchestration and forwarded verbatim to
 *  every driver step — an ORB tenant and an AMS tenant take the identical call shape (#7524's product-agnostic
 *  requirement). A free string, matching tenant-client.ts's `product?: string` ("other fields vary by product"). */
export type Product = string;

/** Product-agnostic tenant identity. Keyed by `name` — the same identifier tenant-client.ts's create/destroy
 *  admin commands address a tenant by. */
export type Tenant = {
  name: string;
  /** #4898 (fleet rollout, decision ratified 2026-07-21): the image version THIS tenant's container resolves
   *  at (re)start, instead of a shared `:latest` tag. Product-agnostic — the same field for ORB and AMS
   *  tenants. Absent/null = unpinned (the tenant follows its release channel's default, exactly the pre-#4898
   *  behavior). A rollout updates this field on an explicit list of tenants; rollback reverts it — see
   *  http-app.ts's `POST /v1/tenants/rollout`. */
  pinnedVersion?: string | null;
};

/** The full tenant lifecycle vocabulary the #7180 provisioning API reports, passed through verbatim by
 *  tenant-client.ts. provisionTenant/deprovisionTenant only ever produce the terminal `"active"` / `"torn down"`
 *  states; `"provisioning"` (transitional — written by the create route before orchestration starts, so a
 *  polling customer can watch the standup, #7677) and `"failed"` (#7677: a provision-step failure, persisted
 *  before the rethrow so that same polling customer sees a terminal "Setup failed" instead of a record stuck
 *  at "provisioning" forever) and `"suspended"` (an operator action) round out the documented set. */
export type TenantLifecycleState =
  "provisioning" | "active" | "suspended" | "failed" | "torn down";

/** Everything one provision/deprovision step needs. A single request type flows through every driver method so a
 *  real and a fake driver see identical inputs, and so ORB and AMS calls are shaped identically. */
export type TenantProvisioningRequest = {
  tenant: Tenant;
  product: Product;
  /** The tenant's already-provisioned database connection details (#7653) -- populated for the `injectSecrets`
   *  call (and, from there on, every step after it -- see `createContainer` below) by `provisionTenant`'s own
   *  orchestration right after `provisionDatabase` resolves (#8066). */
  database?: DatabaseConnectionDetails;
  /** An opaque, driver-specific reference to a previously injected secret (#8066) -- whatever `injectSecrets`
   *  returned as `secretRef`, threaded back in by `deprovisionTenant` so `revokeSecrets` knows what to revoke.
   *  Absent when a tenant was never provisioned with a real secret driver configured (idempotent revoke of an
   *  unconfigured tenant, matching every other driver's teardown contract). */
  secretRef?: string;
  /** A one-time credential the tenant's OWN container can later exchange for a real custodied secret (#8202) --
   *  whatever `injectSecrets` returned as `bootstrapSecret`, threaded by `provisionTenant` into the SAME
   *  `createContainer` call that follows it (#8202 reordered provisioning so this is possible -- see
   *  provisioning.ts). Populated ONLY for that one `createContainer` call; no other step ever sees it, and it is
   *  never itself the delivered secret -- just the key the container uses to fetch one. */
  bootstrapSecret?: string;
};

/** What `provisionDatabase` hands back (#7653): everything a caller needs to actually reach the tenant's
 *  database. `connectionString` is the ready-to-use `postgres://` URI (what a real Neon driver's `host`/`port`/
 *  `user`/`password`/`database` fields compose into); kept alongside the parts so a caller that needs one
 *  field (e.g. just `database` for logging) doesn't have to parse the URI back apart. Routing this through a
 *  Cloudflare Hyperdrive binding is #7654's job once control-plane has a deployable service to attach one to
 *  (see neon-database-driver.ts's header comment) -- this type only carries the raw connection, not a
 *  Hyperdrive-specific shape. */
export type DatabaseConnectionDetails = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionString: string;
};

export interface TenantProvisioningDriver {
  /** Step 1 in call order (#7180), but the LAST of the three to run within `provisionTenant` as of #8202: stand
   *  up the tenant's isolated container. Real driver → Cloudflare Containers API. May see `request.bootstrapSecret`
   *  (#8202, set when `injectSecrets` returned one) to deliver into the container's own process environment at
   *  this, its actual cold-boot `start()` call -- the only point in a container's lifecycle Cloudflare Containers
   *  actually applies `envVars` (confirmed against the real `@cloudflare/containers` SDK: a repeat `start()` on
   *  an already-running/starting instance is a no-op or throws, never re-applies `envVars`). */
  createContainer(request: TenantProvisioningRequest): Promise<void>;
  /** Step 2 (#7180): provision the tenant's database, returning its connection details (#7653) -- a freshly
   *  created role's password is typically retrievable from the provider only at creation time, so the caller
   *  must capture this return value rather than re-deriving it later. Real driver → the chosen Postgres
   *  provider (Neon + Hyperdrive, decided on #7180; see neon-database-driver.ts). */
  provisionDatabase(request: TenantProvisioningRequest): Promise<DatabaseConnectionDetails>;
  /** Step 3 (#7180): inject the tenant's secrets, given its database connection details (`request.database`,
   *  #8066). Returns an opaque `secretRef` the caller must persist and thread back into a later `revokeSecrets`
   *  call via `request.secretRef` -- `undefined` when the driver has nothing to track (e.g. the fake). Also
   *  returns `bootstrapSecret` (#8202): a one-time credential the caller threads into the SAME tenant's next
   *  `createContainer` call (provisioning.ts runs this step BEFORE createContainer specifically so this is
   *  possible), so the running container can itself exchange it later for the real secret this step just
   *  custodied -- `undefined` when the driver has nothing for a container to bootstrap with. A real driver
   *  delegates to #7174's generalized broker (src/orb/broker.ts, via #8064's stored-secret type); the fake only
   *  records the call. */
  injectSecrets(request: TenantProvisioningRequest): Promise<{ secretRef?: string; bootstrapSecret?: string }>;
  /** Teardown inverse of createContainer. MUST be idempotent — safe to call when the container was never
   *  created — so deprovisioning a nonexistent tenant is a no-op, never a throw. */
  destroyContainer(request: TenantProvisioningRequest): Promise<void>;
  /** Teardown inverse of provisionDatabase. Idempotent, like destroyContainer. */
  dropDatabase(request: TenantProvisioningRequest): Promise<void>;
  /** Teardown inverse of injectSecrets. `request.secretRef` (set by the caller from whatever `injectSecrets`
   *  previously returned) tells the driver what to revoke; absent/unrecognized is a safe no-op, matching this
   *  driver contract's existing idempotent-teardown convention. */
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
  /** Product-scoped keys (`${product}:${tenant.name}`, same as container-driver.ts's `instanceNameFor`)
   *  whose container currently "exists" (an in-memory stand-in for real infrastructure). */
  readonly containers: ReadonlySet<string>;
  /** Product-scoped keys whose database currently "exists". */
  readonly databases: ReadonlySet<string>;
  /** Product-scoped keys whose secrets are currently injected. */
  readonly injectedSecrets: ReadonlySet<string>;
  /** Every driver step this fake has run, in call order. */
  readonly calls: readonly FakeDriverCall[];
};

/** Same composite key as container-driver.ts's `instanceNameFor` (#8025) — ORB and AMS tenants that share a
 *  name must not collide in the fake's in-memory maps (production composes this fake for any step without a
 *  real backend yet). */
function instanceKeyFor(request: TenantProvisioningRequest): string {
  return `${request.product}:${request.tenant.name}`;
}

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
      containers.add(instanceKeyFor(request));
    },
    async provisionDatabase(request) {
      record("provisionDatabase", request);
      databases.add(instanceKeyFor(request));
      // Deterministic per-tenant fake connection details -- no real IO, no state beyond the existing
      // `databases` set, just enough shape for callers/tests exercising the widened (#7653) return contract.
      const host = `fake-${request.tenant.name}.control-plane.invalid`;
      const port = 5432;
      const database = request.tenant.name;
      const user = request.tenant.name;
      const password = `fake-password-${request.tenant.name}`;
      return { host, port, database, user, password, connectionString: `postgres://${user}:${password}@${host}:${port}/${database}` };
    },
    async injectSecrets(request) {
      record("injectSecrets", request);
      injectedSecrets.add(instanceKeyFor(request));
      // The fake tracks "injected" via its own `injectedSecrets` set (keyed by tenant), not by a real opaque
      // reference -- it has nothing for a caller to persist and thread back into revokeSecrets later.
      return {};
    },
    async destroyContainer(request) {
      record("destroyContainer", request);
      // Idempotent teardown: the else-branch (nothing to remove) is the "destroy-of-a-nonexistent-tenant"
      // lifecycle path — a no-op, never a throw.
      const key = instanceKeyFor(request);
      if (containers.has(key)) {
        containers.delete(key);
      }
    },
    async dropDatabase(request) {
      record("dropDatabase", request);
      const key = instanceKeyFor(request);
      if (databases.has(key)) {
        databases.delete(key);
      }
    },
    async revokeSecrets(request) {
      record("revokeSecrets", request);
      const key = instanceKeyFor(request);
      if (injectedSecrets.has(key)) {
        injectedSecrets.delete(key);
      }
    },
    async containerExists(request) {
      return containers.has(instanceKeyFor(request));
    },
  };
}
