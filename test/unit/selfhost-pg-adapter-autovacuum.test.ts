// Unit tests for the github_rate_limit_observations autovacuum tuning step (#2543). Uses a mock D1Database
// (just the .exec() surface runSelfHostMigrations already relies on) so no real Postgres is required -- the
// SQL itself is plain, already-Postgres-native syntax with no SQLite constructs for pg-dialect.ts to translate,
// so a mocked interaction test is a faithful, fast substitute for a live ALTER TABLE.
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL,
  tuneGithubRateLimitObservationsAutovacuum,
} from "../../src/selfhost/pg-adapter";

function mockDb(execImpl: (sql: string) => Promise<unknown>): D1Database {
  return { exec: vi.fn(execImpl) } as unknown as D1Database;
}

describe("GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL (#2543)", () => {
  it("targets the github_rate_limit_observations table with a scale factor below Postgres's 0.2 default", () => {
    expect(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL).toContain("github_rate_limit_observations");
    expect(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL).toContain("autovacuum_vacuum_scale_factor");
    const match = GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL.match(/autovacuum_vacuum_scale_factor\s*=\s*([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThan(0.2);
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });

  it("is a single idempotent storage-parameter ALTER, not an additive/destructive DDL statement", () => {
    expect(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL.trim().toUpperCase()).toMatch(/^ALTER TABLE/);
    expect(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
});

describe("tuneGithubRateLimitObservationsAutovacuum (#2543)", () => {
  it("applies the autovacuum SQL via db.exec()", async () => {
    const db = mockDb(async () => ({ count: 1, duration: 0 }));

    await tuneGithubRateLimitObservationsAutovacuum(db);

    expect(db.exec).toHaveBeenCalledWith(GITHUB_RATE_LIMIT_OBSERVATIONS_AUTOVACUUM_SQL);
    expect(db.exec).toHaveBeenCalledTimes(1);
  });

  it("fails open (does not throw) when db.exec rejects -- an optimization, never a boot-blocking dependency", async () => {
    const db = mockDb(async () => {
      throw new Error("connection reset");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tuneGithubRateLimitObservationsAutovacuum(db)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("selfhost_autovacuum_tune_failed"));
    errorSpy.mockRestore();
  });

  it("logs the underlying error message on failure", async () => {
    const db = mockDb(async () => {
      throw new Error("relation does not exist");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await tuneGithubRateLimitObservationsAutovacuum(db);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("relation does not exist"));
    errorSpy.mockRestore();
  });

  it("stringifies a non-Error rejection instead of throwing on error.message access", async () => {
    const db = mockDb(async () => {
      throw "a plain string rejection";
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tuneGithubRateLimitObservationsAutovacuum(db)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("a plain string rejection"));
    errorSpy.mockRestore();
  });
});
