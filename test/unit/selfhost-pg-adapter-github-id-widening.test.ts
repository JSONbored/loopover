// Unit tests for the GitHub-native-id bigint widening step (#selfhost-github-id-overflow). Uses a mock
// D1Database (just the .exec() surface runSelfHostMigrations already relies on) so no real Postgres is
// required -- the SQL itself is plain, already-Postgres-native syntax with no SQLite constructs for
// pg-dialect.ts to translate, so a mocked interaction test is a faithful, fast substitute for a live ALTER
// TABLE. Mirrors selfhost-pg-adapter-autovacuum.test.ts's shape exactly (#2543's sibling fix-up step).
import { describe, expect, it, vi } from "vitest";
import { GITHUB_ID_BIGINT_WIDENING_SQL, widenGithubIdColumnsToBigint } from "../../src/selfhost/pg-adapter";

function mockDb(execImpl: (sql: string) => Promise<unknown>): D1Database {
  return { exec: vi.fn(execImpl) } as unknown as D1Database;
}

describe("GITHUB_ID_BIGINT_WIDENING_SQL (#selfhost-github-id-overflow)", () => {
  it("widens every known GitHub-native-id column to bigint, one ALTER per statement", () => {
    const statements = GITHUB_ID_BIGINT_WIDENING_SQL.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThanOrEqual(18);
    for (const statement of statements) {
      expect(statement.toUpperCase()).toMatch(/^ALTER TABLE \w+ ALTER COLUMN \w+ TYPE bigint$/i);
    }
  });

  it("covers the column that was seen actively overflowing in production (request/response comment ids)", () => {
    expect(GITHUB_ID_BIGINT_WIDENING_SQL).toContain("ALTER TABLE github_agent_command_answers ALTER COLUMN request_comment_id TYPE bigint");
    expect(GITHUB_ID_BIGINT_WIDENING_SQL).toContain("ALTER TABLE github_agent_command_answers ALTER COLUMN response_comment_id TYPE bigint");
  });

  it("is additive-only DDL, never destructive", () => {
    expect(GITHUB_ID_BIGINT_WIDENING_SQL).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
});

describe("widenGithubIdColumnsToBigint (#selfhost-github-id-overflow)", () => {
  it("applies the widening SQL via db.exec() as a single batch", async () => {
    const db = mockDb(async () => ({ count: 1, duration: 0 }));

    await widenGithubIdColumnsToBigint(db);

    expect(db.exec).toHaveBeenCalledWith(GITHUB_ID_BIGINT_WIDENING_SQL);
    expect(db.exec).toHaveBeenCalledTimes(1);
  });

  it("fails open (does not throw) when db.exec rejects -- an idempotent follow-up, never a boot-blocking dependency", async () => {
    const db = mockDb(async () => {
      throw new Error("connection reset");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(widenGithubIdColumnsToBigint(db)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("selfhost_github_id_bigint_widen_failed"));
    errorSpy.mockRestore();
  });

  it("logs the underlying error message on failure", async () => {
    const db = mockDb(async () => {
      throw new Error("relation does not exist");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await widenGithubIdColumnsToBigint(db);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("relation does not exist"));
    errorSpy.mockRestore();
  });

  it("stringifies a non-Error rejection instead of throwing on error.message access", async () => {
    const db = mockDb(async () => {
      throw "a plain string rejection";
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(widenGithubIdColumnsToBigint(db)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("a plain string rejection"));
    errorSpy.mockRestore();
  });
});
