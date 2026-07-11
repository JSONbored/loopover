import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type BoundValue = string | number | null | Uint8Array;

// Listing + reading migrations/*.sql (~90 files) on every TestD1Database construction (~1500 call sites
// across the suite) is pure overhead: the file list and contents never change within a worker process's
// lifetime. Cache the concatenated SQL once per process instead of re-reading it every call.
//
// NOT using node:sqlite's serialize()/deserialize() here: they would let one migrated template be cloned
// per instance instead of re-executing the SQL each time (a much bigger win), but they don't exist on this
// repo's pinned Node 22 (`.nvmrc`) at all -- confirmed absent from DatabaseSync's prototype on Node 22.23.1,
// present only from Node 24+. An earlier version of this cache used them and passed locally on a newer Node,
// but crashed every test in CI (`db.deserialize is not a function`) since CI runs the pinned Node 22. Stick
// to what Node 22 actually supports.
let migratedSql: string | null = null;
function getMigratedSql(): string {
  if (migratedSql) return migratedSql;
  migratedSql = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(`migrations/${file}`, "utf8"))
    .join("\n");
  return migratedSql;
}

export class TestD1Database {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec(getMigratedSql());
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
    MCP_READ_REPO_ALLOWLIST: "*",
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
      // Mirrors createRedisCache's atomic compare-and-delete (#2129): only deletes when the stored value still
      // equals the caller's own token, so a stale holder's release can never delete a different, live claim.
      async releaseIfValue(key: string, value: string) {
        if (transientCache.get(key) !== value) return false;
        transientCache.delete(key);
        return true;
      },
    },
    // Per-repo review allowlist: default to the test repos so flag-ON wiring tests activate the
    // gated review features. Override to "" to assert the dormant (no-repo) default.
    GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory,acme/widgets",
    // Default-ON in production (settings/automation-bot-skip.ts); most tests don't involve a bot actor at
    // all, so this default doesn't change their behavior. Tests exercising this feature override it directly.
    GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "true",
    // Default OFF, matching wrangler.jsonc — a new required `vars` entry needs an explicit base value here
    // (Partial<Env> alone leaves it optional under exactOptionalPropertyTypes, which Env's required field
    // rejects). Tests exercising the experimental gittensor plugin override it directly.
    GITTENSORY_EXPERIMENTAL_GITTENSOR: "false",
    ...overrides,
  };
}
