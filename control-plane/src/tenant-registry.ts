// Tenant registry for control-plane's real HTTP transport (#7654). `TenantProvisioningDriver` has no
// enumeration concept by design (create/destroy/exists are all per-tenant) -- `GET /v1/tenants` needs a
// distinct, durable list of every tenant this service has been asked to create, independent of whatever a
// given driver internally tracks. Deliberately stores ONLY name/product/lifecycle state/timestamps, never a
// tenant's database connection details or any other secret -- this is an admin-visible inventory, not a
// credential store (that's #7852's job, via the generalized broker).
import type { Product, Tenant, TenantLifecycleState } from "./tenant-provisioning-driver.js";

/** One AMS tenant's cron-wake configuration (#7182) -- ORB tenants never have this (they're woken by
 *  incoming webhooks, #7181, not a schedule). `command`/`args` are forwarded verbatim to
 *  `loopover-miner-hosted` (packages/loopover-miner/bin/loopover-miner-hosted.ts) as its own argv -- this
 *  package deliberately does not import loopover-miner's `HostedCycleCommand` type (no cross-package type
 *  coupling in this codebase's existing convention), so `command` is validated as a plain string against the
 *  same three known names at the HTTP layer instead (see http-app.ts). */
export type AmsCycleSchedule = {
  command: string;
  args: string[];
  intervalMs: number;
  /** When this tenant is next due to be woken. Advances by `intervalMs` after every run (#7182's own
   *  "wake, run one cycle, sleep" model), regardless of whether that run succeeded. */
  nextDueAt: string;
  lastRunAt?: string;
  /** The hosted entry point's own exit code from the most recent run (0=success, 2=failure, per
   *  `docs/unattended-scheduling.md`'s existing contract) -- `undefined` until the first run, or if the most
   *  recent run timed out waiting for the container to stop. */
  lastExitCode?: number;
};

export type TenantRegistryRecord = {
  tenant: Tenant;
  product: Product;
  state: TenantLifecycleState;
  createdAt: string;
  updatedAt: string;
  amsSchedule?: AmsCycleSchedule;
  /** The GitHub App installation ID this ORB tenant's hosted container answers webhooks for (#7181) -- ORB
   *  tenants only, mirroring `amsSchedule`'s own AMS-only shape. Set at creation (see http-app.ts's
   *  `POST /v1/tenants`); `orb-webhook-router.ts`'s request-time routing looks up a tenant by this ID to know
   *  which container an incoming webhook belongs to. */
  orbInstallationId?: number;
};

export interface TenantRegistry {
  /** Insert or update a tenant's record. Preserves the original `createdAt` on an update (looked up by the
   *  caller, not this method -- see `http-app.ts`'s own upsert helper). Keyed by `(product, name)` so ORB and
   *  AMS tenants that share a name stay independent (#8024). */
  upsert(record: TenantRegistryRecord): Promise<void>;
  /** Lookup by the same `${product}:${name}` composite as container-driver.ts's `instanceNameFor` (#8024). */
  get(name: string, product: Product): Promise<TenantRegistryRecord | undefined>;
  /** Every tenant this service has ever created, including torn-down ones (mirrors a cloud console showing
   *  terminated instances rather than making them vanish) -- ordered by `tenant.name` then `product` for a
   *  stable listing across products. */
  list(): Promise<TenantRegistryRecord[]>;
  /** Lookup an ORB tenant by its `orbInstallationId` (#7181) -- the only way an incoming GitHub webhook (which
   *  carries an installation ID, never a tenant name) can find the right container to route to. `undefined`
   *  for an installation ID no tenant currently claims. */
  getByOrbInstallationId(installationId: number): Promise<TenantRegistryRecord | undefined>;
}

/** Same composite key as container-driver.ts's `instanceNameFor` (#8024) — ORB and AMS tenants that share a
 *  name must not collide in the admin inventory. */
function instanceKeyFor(name: string, product: Product): string {
  return `${product}:${name}`;
}

function sortRecords(records: TenantRegistryRecord[]): TenantRegistryRecord[] {
  return records.sort(
    (a, b) => a.tenant.name.localeCompare(b.tenant.name) || a.product.localeCompare(b.product),
  );
}

/** In-memory fake for tests -- mirrors `createFakeTenantProvisioningDriver`'s own minimal-fake convention.
 *  `getByOrbInstallationId` is a plain linear scan -- fine for a fake with, at most, a handful of test
 *  records; the real KV-backed registry below needs an actual secondary index instead, since KV has no query
 *  capability at all. */
export function createFakeTenantRegistry(): TenantRegistry {
  const records = new Map<string, TenantRegistryRecord>();
  return {
    async upsert(record) {
      records.set(instanceKeyFor(record.tenant.name, record.product), record);
    },
    async get(name, product) {
      return records.get(instanceKeyFor(name, product));
    },
    async list() {
      return sortRecords([...records.values()]);
    },
    async getByOrbInstallationId(installationId) {
      return [...records.values()].find((record) => record.orbInstallationId === installationId);
    },
  };
}

/** The minimal slice of Cloudflare's real `KVNamespace` this module actually calls -- kept as a small local
 *  interface (not a `@cloudflare/workers-types` import) so this file stays plain, portable TypeScript,
 *  testable with a trivial in-memory fake under `node:test` with no Workers-specific tooling. */
export type KvNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
};

const KEY_PREFIX = "tenant:";
const INSTALLATION_INDEX_PREFIX = "installation:";

function keyFor(name: string, product: Product): string {
  return `${KEY_PREFIX}${instanceKeyFor(name, product)}`;
}

/** Secondary index key for #7181's webhook routing: an incoming GitHub webhook only carries an installation
 *  ID, never a tenant name, and KV has no query/scan-by-field capability -- so this points straight at the
 *  tenant's own primary key, kept in sync by `upsert` below (write-time index maintenance, not a live query). */
function installationIndexKeyFor(installationId: number): string {
  return `${INSTALLATION_INDEX_PREFIX}${installationId}`;
}

/** Real registry backed by Workers KV. `list()` pages through every `tenant:`-prefixed key (KV's own `list()`
 *  caps each call at 1000 keys) rather than assuming a single page covers the whole registry. Keys are
 *  `tenant:${product}:${name}` (#8024). */
export function createKvTenantRegistry(kv: KvNamespaceLike): TenantRegistry {
  return {
    async upsert(record) {
      const primaryKey = keyFor(record.tenant.name, record.product);
      // Keep the installation-ID secondary index in sync: if this update changes (or clears) which
      // installation the tenant claims, the stale pointer must go, or a re-linked/unlinked installation ID
      // would keep resolving to the wrong (or a deleted) tenant. Reading the previous record here is the only
      // way to know the OLD installationId -- `upsert` itself only ever receives the new one.
      const previousRaw = await kv.get(primaryKey);
      const previous = previousRaw ? (JSON.parse(previousRaw) as TenantRegistryRecord) : undefined;
      if (previous?.orbInstallationId !== undefined && previous.orbInstallationId !== record.orbInstallationId) {
        await kv.delete(installationIndexKeyFor(previous.orbInstallationId));
      }
      await kv.put(primaryKey, JSON.stringify(record));
      if (record.orbInstallationId !== undefined) {
        await kv.put(installationIndexKeyFor(record.orbInstallationId), primaryKey);
      }
    },
    async get(name, product) {
      const raw = await kv.get(keyFor(name, product));
      return raw ? (JSON.parse(raw) as TenantRegistryRecord) : undefined;
    },
    async list() {
      const records: TenantRegistryRecord[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await kv.list({ prefix: KEY_PREFIX, ...(cursor ? { cursor } : {}) });
        const values = await Promise.all(page.keys.map((key) => kv.get(key.name)));
        for (const raw of values) {
          if (raw) records.push(JSON.parse(raw) as TenantRegistryRecord);
        }
        if (page.list_complete || !page.cursor) break;
        cursor = page.cursor;
      }
      return sortRecords(records);
    },
    async getByOrbInstallationId(installationId) {
      const primaryKey = await kv.get(installationIndexKeyFor(installationId));
      if (!primaryKey) return undefined;
      const raw = await kv.get(primaryKey);
      return raw ? (JSON.parse(raw) as TenantRegistryRecord) : undefined;
    },
  };
}
