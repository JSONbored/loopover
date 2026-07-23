import { describe, expect, it } from "vitest";
import { pgDatabaseLabel, resolvePgConnection } from "../../scripts/pg-cli";

// #8171: the pure driver-selection half of the calibration CLIs' pg path. The IO half (openPgDatabase)
// is exercised for real by the PG_TEST_URL-gated integration suite + the selfhost CI job.

describe("resolvePgConnection (#8171)", () => {
  it("returns null when --pg is absent — DATABASE_URL alone must never silently switch drivers", () => {
    expect(resolvePgConnection(false, undefined, "postgres://env/db")).toBeNull();
  });

  it("prefers the explicit --pg value over DATABASE_URL", () => {
    expect(resolvePgConnection(true, "postgres://flag/db", "postgres://env/db")).toBe("postgres://flag/db");
  });

  it("falls back to DATABASE_URL on a bare --pg (mirroring the selfhost stack's own driver pick)", () => {
    expect(resolvePgConnection(true, undefined, "postgres://env/db")).toBe("postgres://env/db");
    expect(resolvePgConnection(true, "   ", " postgres://env/db ")).toBe("postgres://env/db");
  });

  it("fails loud on a bare --pg with no DATABASE_URL — a silent D1 fall-through could read the wrong deployment's ledger", () => {
    expect(() => resolvePgConnection(true, undefined, undefined)).toThrow(/DATABASE_URL/);
    expect(() => resolvePgConnection(true, "", "  ")).toThrow(/DATABASE_URL/);
  });
});

describe("pgDatabaseLabel (#8171)", () => {
  it("names the database without the credentials the connection string carries", () => {
    const label = pgDatabaseLabel("postgres://user:s3cret@host:5432/loopover");
    expect(label).toBe("postgres:loopover");
    expect(label).not.toContain("s3cret");
  });

  it("degrades to the bare driver name on an unparseable string or a missing database path", () => {
    expect(pgDatabaseLabel("not a url")).toBe("postgres");
    expect(pgDatabaseLabel("postgres://host:5432/")).toBe("postgres");
  });
});
