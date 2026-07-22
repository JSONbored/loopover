// Real `createContainer`/`destroyContainer`/`containerExists` implementation against Cloudflare Containers
// (#7851, part of #7180's provisioning core -- the container platform + one-per-tenant-per-product model was
// already ratified on #7173). One tenant+product pair = one Container Durable Object instance, keyed by
// `${product}:${tenant.name}`.
//
// Deliberately does NOT implement the full `TenantProvisioningDriver` interface -- only the container methods
// (see `ContainerDriver` below). Database provisioning (#7653) and secret injection (#7852) are separate,
// independently-shippable pieces; `withRealContainerDriver` (driver-factory.ts) composes this onto an
// otherwise fake/real-mixed driver.
//
// "Provisioned" is tracked as an explicit flag the paired Container DO stores in its OWN durable storage
// (see worker.ts's ProvisionedContainer base class), NOT derived from Cloudflare's own transient container
// run-state (`getState()`'s `running`/`stopped`/`stopped_with_code`, etc). That distinction matters concretely
// for AMS: its existing Docker image (packages/loopover-miner/Dockerfile) is a one-shot CLI tool with no
// long-running process -- per #7182's own design, a legitimately-provisioned, currently-dormant AMS tenant's
// container is EXPECTED to sit in a "stopped"-shaped run state almost all the time, which is indistinguishable
// from "never provisioned" using run-state alone. An explicit, durable flag is unambiguous for either product.
import type { Product, TenantProvisioningRequest } from "./tenant-provisioning-driver.js";

/** The slice of a real Container DO's RPC surface this module actually calls. Kept as a small local
 *  interface (not the real `@cloudflare/containers` types) so this file stays plain, portable TypeScript,
 *  testable with a trivial fake under `node:test` -- mirrors neon-database-driver.ts's and
 *  tenant-registry.ts's own identical "local interface, no SDK import" convention. */
export type ContainerStubLike = {
  start(options?: { envVars?: Record<string, string>; entrypoint?: string[]; enableInternet?: boolean }): Promise<void>;
  stop(): Promise<void>;
  isProvisioned(): Promise<boolean>;
  markProvisioned(): Promise<void>;
  markDeprovisioned(): Promise<void>;
};

export type ContainerNamespaceLike = {
  getByName(name: string): ContainerStubLike;
};

export type ContainerDriverConfig = {
  /** One binding per product -- ORB and AMS run different Docker images (root Dockerfile vs
   *  packages/loopover-miner/Dockerfile), and a Cloudflare Container binding is fixed to one image at the
   *  wrangler.jsonc level, so a single shared binding can't switch images per request. Keyed by the exact
   *  `product` string `TenantProvisioningRequest` carries; an unconfigured product is a real
   *  misconfiguration, not a silent no-op (see `bindingFor`). */
  bindings: Record<Product, ContainerNamespaceLike>;
};

export type ContainerDriver = {
  createContainer(request: TenantProvisioningRequest): Promise<void>;
  destroyContainer(request: TenantProvisioningRequest): Promise<void>;
  containerExists(request: TenantProvisioningRequest): Promise<boolean>;
};

function instanceNameFor(request: TenantProvisioningRequest): string {
  return `${request.product}:${request.tenant.name}`;
}

function bindingFor(config: ContainerDriverConfig, product: Product): ContainerNamespaceLike {
  const binding = config.bindings[product];
  if (!binding) throw new Error(`no container binding configured for product "${product}"`);
  return binding;
}

/** Idempotent: an already-provisioned tenant's container is left running as-is, never restarted -- a repeat
 *  create must not interrupt a container mid-work. */
export async function createTenantContainer(config: ContainerDriverConfig, request: TenantProvisioningRequest): Promise<void> {
  const stub = bindingFor(config, request.product).getByName(instanceNameFor(request));
  if (await stub.isProvisioned()) return;
  await stub.start();
  await stub.markProvisioned();
}

/** Idempotent: a tenant that was never provisioned (or already torn down) is a safe no-op, matching every
 *  other driver's teardown contract. */
export async function destroyTenantContainer(config: ContainerDriverConfig, request: TenantProvisioningRequest): Promise<void> {
  const stub = bindingFor(config, request.product).getByName(instanceNameFor(request));
  if (!(await stub.isProvisioned())) return;
  await stub.stop();
  await stub.markDeprovisioned();
}

export async function tenantContainerExists(config: ContainerDriverConfig, request: TenantProvisioningRequest): Promise<boolean> {
  const stub = bindingFor(config, request.product).getByName(instanceNameFor(request));
  return stub.isProvisioned();
}

/** Bundles the three functions above as a {@link ContainerDriver} closed over one config -- the shape
 *  `withRealContainerDriver` composes onto a full `TenantProvisioningDriver`. */
export function createContainerDriver(config: ContainerDriverConfig): ContainerDriver {
  return {
    createContainer: (request) => createTenantContainer(config, request),
    destroyContainer: (request) => destroyTenantContainer(config, request),
    containerExists: (request) => tenantContainerExists(config, request),
  };
}
