import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type BoundValue = string | number | null | Uint8Array;

export class TestD1Database {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    for (const migrationFile of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(`migrations/${migrationFile}`, "utf8"));
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
        const columns = statement.columns().map((column) => column.name);
        const rows = statement.all(...bound) as Record<string, unknown>[];
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
  return {
    DB: new TestD1Database() as unknown as D1Database,
    JOBS: {
      async send() {
        return undefined;
      },
    } as unknown as Queue,
    GITHUB_APP_ID: "3824093",
    GITHUB_APP_SLUG: "gittensory",
    GITTENSOR_REGISTRY_URL: "https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/validator/weights/master_repositories.json",
    PUBLIC_API_ORIGIN: "https://api.gittensory.aethereal.dev",
    INTERNAL_JOB_TOKEN: "dev-internal-token",
    GITTENSORY_API_TOKEN: "test-api-token",
    GITTENSORY_MCP_TOKEN: "test-mcp-token",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    ...overrides,
  };
}
