// Tenant registry for control-plane's real HTTP transport (#7654). `TenantProvisioningDriver` has no
// enumeration concept by design (create/destroy/exists are all per-tenant) -- `GET /v1/tenants` needs a
// distinct, durable list of every tenant this service has been asked to create, independent of whatever a
// given driver internally tracks. Deliberately stores ONLY name/product/lifecycle state/timestamps, never a
// tenant's database connection details or any other secret -- this is an admin-visible inventory, not a
// credential store (that's #7852's job, via the generalized broker).
import type { Product, Tenant, TenantLifecycleState } from "./tenant-provisioning-driver.js";

export type TenantRegistryRecord = {
  tenant: Tenant;
  product: Product;
  state: TenantLifecycleState;
  createdAt: string;
  updatedAt: string;
};

export interface TenantRegistry {
  /** Insert or update a tenant's record. Preserves the original `createdAt` on an update (looked up by the
   *  caller, not this method -- see `http-app.ts`'s own upsert helper). */
  upsert(record: TenantRegistryRecord): Promise<void>;
  get(name: string): Promise<TenantRegistryRecord | undefined>;
  /** Every tenant this service has ever created, including torn-down ones (mirrors a cloud console showing
   *  terminated instances rather than making them vanish) -- ordered by `tenant.name` for a stable listing. */
  list(): Promise<TenantRegistryRecord[]>;
}

/** In-memory fake for tests -- mirrors `createFakeTenantProvisioningDriver`'s own minimal-fake convention. */
export function createFakeTenantRegistry(): TenantRegistry {
  const records = new Map<string, TenantRegistryRecord>();
  return {
    async upsert(record) {
      records.set(record.tenant.name, record);
    },
    async get(name) {
      return records.get(name);
    },
    async list() {
      return [...records.values()].sort((a, b) => a.tenant.name.localeCompare(b.tenant.name));
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

function keyFor(name: string): string {
  return `${KEY_PREFIX}${name}`;
}

/** Real registry backed by Workers KV. `list()` pages through every `tenant:`-prefixed key (KV's own `list()`
 *  caps each call at 1000 keys) rather than assuming a single page covers the whole registry. */
export function createKvTenantRegistry(kv: KvNamespaceLike): TenantRegistry {
  return {
    async upsert(record) {
      await kv.put(keyFor(record.tenant.name), JSON.stringify(record));
    },
    async get(name) {
      const raw = await kv.get(keyFor(name));
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
      return records.sort((a, b) => a.tenant.name.localeCompare(b.tenant.name));
    },
  };
}
