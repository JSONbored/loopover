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

/** In-memory fake for tests -- mirrors `createFakeTenantProvisioningDriver`'s own minimal-fake convention. */
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
  };
}

/** The minimal slice of Cloudflare's real `KVNamespace` this module actually calls -- kept as a small local
 *  interface (not a `@cloudflare/workers-types` import) so this file stays plain, portable TypeScript,
 *  testable with a trivial in-memory fake under `node:test` with no Workers-specific tooling. */
export type KvNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
};

const KEY_PREFIX = "tenant:";

function keyFor(name: string, product: Product): string {
  return `${KEY_PREFIX}${instanceKeyFor(name, product)}`;
}

/** Real registry backed by Workers KV. `list()` pages through every `tenant:`-prefixed key (KV's own `list()`
 *  caps each call at 1000 keys) rather than assuming a single page covers the whole registry. Keys are
 *  `tenant:${product}:${name}` (#8024). */
export function createKvTenantRegistry(kv: KvNamespaceLike): TenantRegistry {
  return {
    async upsert(record) {
      await kv.put(keyFor(record.tenant.name, record.product), JSON.stringify(record));
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
  };
}
