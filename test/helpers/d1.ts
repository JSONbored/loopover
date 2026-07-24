import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type BoundValue = string | number | null | Uint8Array;

// Executing the full migrations/*.sql chain (178 files and growing) into a fresh :memory: database on
// EVERY TestD1Database construction (~1500 call sites across the suite) was the suite's single biggest
// time sink: ~640ms per construction, ~950s aggregate per full run, and it inflated ordinary tests into
// the 3s+ range. Instead, build ONE fully-migrated template database file per migration-chain content
// (shared across every vitest worker), then give each instance its own copyFileSync clone: ~1.5ms per
// construction including a verified write, identical schema, fully isolated state.
//
// Design constraints this shape answers (each learned the hard way):
// - node:sqlite's serialize()/deserialize() (the in-memory equivalent of this clone) don't exist on the
//   pinned Node 22 (`.nvmrc`) at all -- absent from DatabaseSync's prototype on 22.23.1, present only
//   from Node 24+. An earlier attempt used them and crashed every test in CI. File copy is Node-22-safe.
// - The clone file must NOT be unlinked while its database is open: SQLite detects the missing main file
//   and fails every later write with SQLITE_READONLY_DBMOVED ("attempt to write a readonly database").
//   Clones therefore stay on disk until the single exit sweep below removes them.
// - Vitest's per-file module isolation re-evaluates this module constantly, so ALL memoization lives on
//   globalThis, never in module-scope state -- module-scope memos would rebuild the template once per
//   test FILE (~640ms each), silently giving back most of the win.
// - The template is keyed by a hash of the concatenated migration SQL, and built at a `.tmp` sibling
//   then renameSync'd (atomic) into place -- concurrent workers can double-build harmlessly, but no
//   reader can ever copy a half-written template, and a schema change gets a fresh key instead of a
//   stale reuse. page_size=1024 + VACUUM shrink the empty-schema template ~3.4x (1.4MB -> ~410KB), which
//   bounds worst-case tmpdir usage for a full run's clones to a few hundred MB, swept at worker exit.
type TestD1GlobalState = {
  templatePath?: string;
  cloneCounter: number;
  clonePaths: string[];
  exitSweepRegistered: boolean;
};

function testD1State(): TestD1GlobalState {
  const holder = globalThis as { __loopoverTestD1State?: TestD1GlobalState };
  holder.__loopoverTestD1State ??= {
    cloneCounter: 0,
    clonePaths: [],
    exitSweepRegistered: false,
  };
  return holder.__loopoverTestD1State;
}

function getMigratedTemplatePath(): string {
  const state = testD1State();
  if (state.templatePath) return state.templatePath;
  const migratedSql = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(`migrations/${file}`, "utf8"))
    .join("\n");
  const key = createHash("sha256").update(migratedSql).digest("hex").slice(0, 16);
  const path = join(tmpdir(), `loopover-test-migrated-${key}.sqlite3`);
  if (!existsSync(path)) {
    const buildPath = `${path}.${process.pid}.tmp`;
    const template = new DatabaseSync(buildPath);
    template.exec("PRAGMA page_size=1024;");
    template.exec(migratedSql);
    template.exec("VACUUM;");
    template.close();
    renameSync(buildPath, path);
  }
  state.templatePath = path;
  return path;
}

export class TestD1Database {
  readonly db: DatabaseSync;

  constructor() {
    const state = testD1State();
    const clonePath = join(
      tmpdir(),
      `loopover-test-clone-${process.pid}-${state.cloneCounter++}-${Math.random().toString(36).slice(2, 8)}.sqlite3`,
    );
    copyFileSync(getMigratedTemplatePath(), clonePath);
    this.db = new DatabaseSync(clonePath);
    state.clonePaths.push(clonePath);
    if (!state.exitSweepRegistered) {
      state.exitSweepRegistered = true;
      process.on("exit", () => {
        for (const path of state.clonePaths) {
          try {
            unlinkSync(path);
          } catch {
            // best-effort tmp hygiene only
          }
        }
      });
    }
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
    GITHUB_APP_SLUG: "loopover-orb",
    GITTENSOR_UPSTREAM_REPO: "entrius/gittensor",
    GITTENSOR_UPSTREAM_REF: "test",
    GITTENSOR_REGISTRY_URL: "https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/validator/weights/master_repositories.json",
    LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "false",
    SATISFACTION_FLOOR_AUTOTUNE_ENABLED: "false",
    AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "false",
    AI_REVIEW_CLOSE_CONFIDENCE_TIGHTEN_ENABLED: "false",
    CONFIG_DRIFT_SENTINEL_ENABLED: "false",
    // Deliberately NOT "JSONbored/gittensory" (the old pre-rename repo name most test fixtures use as their
    // generic placeholder repoFullName) and NOT "JSONbored/loopover" (the real self-repo default) -- either
    // would make isLoopOverSelfRepo() accidentally match a fixture that has no intent to exercise self-repo
    // manifest resolution, silently merging the bundled autonomy:{...auto} block into that test's settings.
    // Tests that DO want self-repo matching set this explicitly to their own fixture's repo name.
    LOOPOVER_DRIFT_ISSUE_REPO: "test-harness/no-self-repo-match",
    PUBLIC_API_ORIGIN: "https://api.loopover.ai",
    PUBLIC_SITE_ORIGIN: "https://loopover.ai",
    INTERNAL_JOB_TOKEN: "dev-internal-token",
    LOOPOVER_API_TOKEN: "test-api-token",
    LOOPOVER_MCP_TOKEN: "test-mcp-token",
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
    LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory,acme/widgets",
    // Default-ON in production (settings/automation-bot-skip.ts); most tests don't involve a bot actor at
    // all, so this default doesn't change their behavior. Tests exercising this feature override it directly.
    LOOPOVER_SKIP_AUTOMATION_BOT_PRS: "true",
    // Default OFF, matching wrangler.jsonc — a new required `vars` entry needs an explicit base value here
    // (Partial<Env> alone leaves it optional under exactOptionalPropertyTypes, which Env's required field
    // rejects). Tests exercising the experimental gittensor plugin override it directly.
    LOOPOVER_EXPERIMENTAL_GITTENSOR: "false",
    // Default OFF, matching wrangler.jsonc, for the same exactOptionalPropertyTypes reason as
    // LOOPOVER_EXPERIMENTAL_GITTENSOR above. Tests exercising the fairness-analytics internal routes override
    // it directly.
    LOOPOVER_FAIRNESS_ANALYTICS: "false",
    ...overrides,
  };
}

/** #5027: createTestEnv() always carries SELFHOST_TRANSIENT_CACHE, so isSelfHostedReviewRuntime(env) reads
 *  `true` by default -- combined with LOOPOVER_EXPERIMENTAL_GITTENSOR defaulting to "false", a plain
 *  createTestEnv() now exercises persistRegistrySnapshot's self-host-scoped branch with zero repos opted
 *  in, so a seeded registry snapshot never actually registers anything. Use this instead of createTestEnv
 *  for any test that needs persistRegistrySnapshot to register a repo as unrelated setup scaffolding (most
 *  callers), matching the pre-#5027 unscoped behavior those tests were written against. Tests that
 *  specifically exercise the self-host-scoping behavior itself should use createTestEnv directly and
 *  configure LOOPOVER_EXPERIMENTAL_GITTENSOR / a manifest opt-in explicitly instead. */
export function createCloudTestEnv(overrides: Partial<Env> = {}): Env {
  const env = createTestEnv(overrides);
  delete env.SELFHOST_TRANSIENT_CACHE;
  return env;
}

/** Same idea as {@link createCloudTestEnv}, but for a shared seed helper that receives an ALREADY-BUILT env
 *  as a parameter (rather than constructing its own) -- shallow-clones it (same env.DB reference, so writes
 *  still land in the caller's test database) with SELFHOST_TRANSIENT_CACHE stripped, so a single call to
 *  persistRegistrySnapshot(asCloudEnv(env), ...) inside the helper is enough to un-scope that one write,
 *  without having to touch every individual test's own createTestEnv() call. */
export function asCloudEnv(env: Env): Env {
  const cloudEnv = { ...env };
  delete cloudEnv.SELFHOST_TRANSIENT_CACHE;
  return cloudEnv;
}
