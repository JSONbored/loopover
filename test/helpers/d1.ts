import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type BoundValue = string | number | null | Uint8Array;

// node:sqlite's DatabaseSync supports serialize()/deserialize() at runtime (verified against the installed
// Node binary), but the bundled @types/node (24.13.2) hasn't caught up with these newer methods yet — bridge
// the gap with a narrow local type instead of widening DatabaseSync usage elsewhere to `any`.
type SerializableDatabaseSync = DatabaseSync & {
  serialize(): Uint8Array;
  deserialize(data: Uint8Array): void;
};

// Replaying every migrations/*.sql file into a fresh DatabaseSync is the dominant cost of constructing a
// TestD1Database (~1500 call sites across the suite; ~33ms/call measured, almost entirely migration replay).
// Build the migrated schema ONCE per worker process, serialize it, and clone that snapshot for every
// subsequent instance instead of re-executing ~90 files each time (~1000x faster per call; same resulting
// schema, since node:sqlite's deserialize() loads the exact byte-for-byte database the snapshot came from).
// This cache is process-local and never invalidated within a run — correct only because migrations/*.sql
// are read-only for the lifetime of a worker process; no test mutates a migration file in-process. If that
// ever changes, this snapshot would need invalidating too.
let migratedSnapshot: Uint8Array | null = null;
function getMigratedSnapshot(): Uint8Array {
  if (migratedSnapshot) return migratedSnapshot;
  const template = new DatabaseSync(":memory:") as SerializableDatabaseSync;
  for (const migrationFile of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    template.exec(readFileSync(`migrations/${migrationFile}`, "utf8"));
  }
  migratedSnapshot = template.serialize();
  template.close();
  return migratedSnapshot;
}

export class TestD1Database {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    (this.db as SerializableDatabaseSync).deserialize(getMigratedSnapshot());
  }

  prepare(sql: string) {
    const database = this.db;
    const statement = database.prepare(sql);
    let bound: BoundValue[] = [];
    const api = {
      bind(...values: BoundValue[]) {
        bound = values;
        return api;
      },
      async first<T = unknown>() {
        return statement.get(...bound) as T | null;
      },
      async all<T = unknown>() {
        return { results: statement.all(...bound) as T[] };
      },
      async raw<T = unknown[]>() {
        const rows = statement.all(...bound) as Record<string, unknown>[];
        if (rows.length === 0) return [] as T[];
        const columns = Object.keys(rows[0]!);
        return rows.map((row) => columns.map((column) => row[column])) as T[];
      },
      async run() {
        const result = statement.run(...bound);
        return { success: true, meta: { changes: Number(result.changes ?? 0) }, results: [] };
      },
    };
    return api;
  }

  async batch(statements: Array<ReturnType<TestD1Database["prepare"]>>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  const transientCache = new Map<string, string>();
  return {
    DB: new TestD1Database() as unknown as D1Database,
    JOBS: {
      async send() {
        return undefined;
      },
    } as unknown as Queue,
    WEBHOOKS: {
      async send() {
        return undefined;
      },
    } as unknown as Queue,
    GITHUB_APP_ID: "3824093",
    GITHUB_APP_SLUG: "gittensory",
    GITTENSOR_UPSTREAM_REPO: "entrius/gittensor",
    GITTENSOR_UPSTREAM_REF: "test",
    GITTENSOR_REGISTRY_URL: "https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/validator/weights/master_repositories.json",
    GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "false",
    GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory",
    PUBLIC_API_ORIGIN: "https://gittensory-api.aethereal.dev",
    PUBLIC_SITE_ORIGIN: "https://gittensory.aethereal.dev",
    INTERNAL_JOB_TOKEN: "dev-internal-token",
    GITTENSORY_API_TOKEN: "test-api-token",
    GITTENSORY_MCP_TOKEN: "test-mcp-token",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    ADMIN_GITHUB_LOGINS: "jsonbored",
    MCP_ACTUATION_REPO_ALLOWLIST: "*",
    SELFHOST_TRANSIENT_CACHE: {
      async get(key: string) {
        return transientCache.get(key) ?? null;
      },
      async set(key: string, value: string) {
        transientCache.set(key, value);
      },
      async del(key: string) {
        transientCache.delete(key);
      },
      // Mirrors createRedisCache's atomic claim (#2129): the check-and-set below has no `await` between the
      // `has` read and the `set` write, so it completes synchronously within one microtask — a concurrent
      // caller can never observe the key as absent partway through another caller's claim, matching Redis's
      // SET NX server-side atomicity.
      async claim(key: string, value: string) {
        if (transientCache.has(key)) return false;
        transientCache.set(key, value);
        return true;
      },
    },
    // Per-repo review allowlist: default to the test repos so flag-ON wiring tests activate the
    // gated review features. Override to "" to assert the dormant (no-repo) default.
    GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory,acme/widgets",
    ...overrides,
  };
}
